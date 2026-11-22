'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CSV_HEADERS = [
  'Question',
  'OptionA',
  'OptionB',
  'OptionC',
  'OptionD',
  'Correct',
  'TimeLimit',
  'Multiplier',
  'Category',
  'Explanation'
];

const VERTEX_MODEL_ID = process.env.VERTEX_MODEL_ID || 'gemini-3.8-flash';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const GCLOUD_CACHE_TTL_MS = 45 * 60 * 1000; // 45 minutes
const MAX_SOURCE_TEXT_CHARS = 40000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let cachedTokenSource = null; // 'metadata' | 'gcloud' | 'env'
let cachedGcloudProjectId = null;

function resolveProjectId() {
  const fromEnv = (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    ''
  ).trim();
  if (fromEnv) return fromEnv;
  if (cachedGcloudProjectId) return cachedGcloudProjectId;
  try {
    const out = execFileSync('gcloud', ['config', 'get-value', 'project'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (out && out !== '(unset)') {
      cachedGcloudProjectId = out;
      return out;
    }
  } catch (_err) {
    // Ignore gcloud lookup error
  }
  throw createHttpError(
    503,
    'GOOGLE_CLOUD_PROJECT is not configured. Set GOOGLE_CLOUD_PROJECT in your environment or .env file to use Vertex AI Quiz Generation.'
  );
}

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeWhitespace(str) {
  return String(str ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeMultilineText(str) {
  return String(str ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Resolves pointsMultiplier into strictly 0, 1, or 2.
 * Priority:
 *  - Explicit pointsMultiplier / multiplier (0, 1, 2 or 'poll'/'0x', '1x'/'standard', '2x'/'boss'/'double')
 *  - Otherwise if doublePoints === true -> 2, else 1.
 */
function resolvePointsMultiplier(raw) {
  const rawMult = raw.pointsMultiplier ?? raw.multiplier;
  if (rawMult !== undefined && rawMult !== null && String(rawMult).trim() !== '') {
    if (typeof rawMult === 'boolean') {
      return rawMult ? 2 : 1;
    }
    const str = String(rawMult).trim().toLowerCase();
    if (str === '0' || str === '0x' || str === 'poll' || str === 'none') return 0;
    if (str === '1' || str === '1x' || str === 'standard' || str === 'normal') return 1;
    if (str === '2' || str === '2x' || str === 'boss' || str === 'double' || str === 'true') return 2;
    const num = Number(str);
    if (num === 0 || num === 1 || num === 2) return num;
  }
  return raw.doublePoints === true ? 2 : 1;
}

/**
 * Resolves the correct answer index (0..options.length - 1) from flexible representations:
 * - `correctIndex`: 0-based integer
 * - `correct` / `answer` / `correctAnswer`:
 *   - Letter 'A'/'B'/'C'/'D' (case-insensitive, also 'Option A', 'A)')
 *   - Boolean or 'True'/'False' / 'T'/'F' (matched against option text)
 *   - Exact matching option text (case-insensitive)
 *   - Numeric index:
 *     - When `oneBasedNumbers === true` (CSV/TSV/Markdown human inputs): '1'..'N' -> 0..N-1 ('0' -> 0)
 *     - When `oneBasedNumbers === false` (JSON objects): 0..N-1 -> 0..N-1 (and N -> N-1 if 1-based)
 */
function resolveCorrectIndex(raw, options, { oneBasedNumbers = false } = {}) {
  if (
    raw.correctIndex !== undefined &&
    raw.correctIndex !== null &&
    String(raw.correctIndex).trim() !== ''
  ) {
    const idx = Number(raw.correctIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
      return idx;
    }
    return -1;
  }

  const candidate =
    raw.correct ?? raw.answer ?? raw.correctAnswer ?? raw.correctOption;
  if (candidate === undefined || candidate === null || String(candidate).trim() === '') {
    return -1;
  }

  if (typeof candidate === 'boolean') {
    const target = candidate ? 'true' : 'false';
    const matchIdx = options.findIndex((o) => o.toLowerCase() === target);
    return matchIdx !== -1 ? matchIdx : candidate ? 0 : 1;
  }

  if (typeof candidate === 'number' && Number.isInteger(candidate)) {
    if (oneBasedNumbers) {
      if (candidate >= 1 && candidate <= options.length) return candidate - 1;
      if (candidate === 0) return 0;
    } else {
      if (candidate >= 0 && candidate < options.length) return candidate;
      if (candidate === options.length && candidate >= 1) return candidate - 1;
    }
    return -1;
  }

  const str = String(candidate).trim();
  const lower = str.toLowerCase();

  // 1. Single letter A..Z or "Option A" / "A)" / "(B)" (up to options.length)
  const letterMatch = str.match(/^(?:option\s+|opt\s+|\()?([a-zA-Z])(?:\)|\.|:)?$/i);
  if (letterMatch) {
    const ch = letterMatch[1].toUpperCase();
    // Special case for T / F on 2-option True/False questions
    if (options.length === 2 && (ch === 'T' || ch === 'F')) {
      const tfTarget = ch === 'T' ? 'true' : 'false';
      const tfIdx = options.findIndex((o) => o.toLowerCase() === tfTarget);
      if (tfIdx !== -1) return tfIdx;
      return ch === 'T' ? 0 : 1;
    }
    const letterIdx = ch.charCodeAt(0) - 65;
    if (letterIdx >= 0 && letterIdx < options.length) {
      return letterIdx;
    }
  }

  // 2. Exact case-insensitive match against an option's text (handles "True"/"False" and custom text)
  // For pure digits like "1".."4" in CSV/Markdown (`oneBasedNumbers === true`), prefer 1-based position
  // unless options themselves aren't matched by 1..N or exact match is unambiguous non-digit text.
  const isPureDigit = /^\d+$/.test(str);
  if (!isPureDigit) {
    const exactIdx = options.findIndex((o) => o.toLowerCase() === lower);
    if (exactIdx !== -1) return exactIdx;
  }

  // 3. Numeric strings
  if (isPureDigit) {
    const num = Number(str);
    if (oneBasedNumbers) {
      if (num >= 1 && num <= options.length) return num - 1;
      if (num === 0) return 0;
      const exactIdx = options.findIndex((o) => o.toLowerCase() === lower);
      if (exactIdx !== -1) return exactIdx;
    } else {
      const exactIdx = options.findIndex((o) => o.toLowerCase() === lower);
      if (num >= 0 && num < options.length) return num;
      if (num === options.length && num >= 1) return num - 1;
      if (exactIdx !== -1) return exactIdx;
    }
  }

  // 4. Fallback stripped prefix match (e.g. Answer: "B) HTTP/1.1")
  const strippedPrefix = str.replace(/^\(?([a-zA-Z]|\d+)(?:\)|\.|:|-)\s+/, '').trim().toLowerCase();
  if (strippedPrefix && strippedPrefix !== lower) {
    const idx = options.findIndex((o) => o.toLowerCase() === strippedPrefix);
    if (idx !== -1) return idx;
  }

  return -1;
}

/**
 * Extracts raw options array (and any embedded correct flag) from a raw question object.
 */
function extractRawOptions(raw) {
  let rawList = raw.options ?? raw.choices ?? raw.answers;
  let embeddedCorrectIdx = -1;

  if (!Array.isArray(rawList)) {
    const flatKeys = [
      raw.optionA ?? raw.OptionA ?? raw.optA ?? raw.a ?? raw.A,
      raw.optionB ?? raw.OptionB ?? raw.optB ?? raw.b ?? raw.B,
      raw.optionC ?? raw.OptionC ?? raw.optC ?? raw.c ?? raw.C,
      raw.optionD ?? raw.OptionD ?? raw.optD ?? raw.d ?? raw.D
    ];
    if (flatKeys.some((v) => v !== undefined && v !== null && String(v).trim() !== '')) {
      rawList = flatKeys;
    }
  }

  if (!Array.isArray(rawList)) {
    return { options: [], embeddedCorrectIdx: -1 };
  }

  const cleaned = rawList.map((item, idx) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if (item.isCorrect === true || item.correct === true) {
        embeddedCorrectIdx = idx;
      }
      return normalizeWhitespace(item.text ?? item.label ?? item.value ?? item.option ?? '');
    }
    return normalizeWhitespace(item);
  });

  // Trim trailing blank slots (e.g. CSV/UI 4-slot arrays where OptionC and OptionD are blank for True/False)
  while (cleaned.length > 2 && cleaned[cleaned.length - 1] === '') {
    cleaned.pop();
  }

  return { options: cleaned, embeddedCorrectIdx };
}

/**
 * Validates an array of 1..100 questions and normalizes each into the QuizArena canonical schema:
 * `{ id, type: 'mcq' | 'tf', category, slideRef, question, options, correctIndex, timeLimit, pointsMultiplier, doublePoints, explanation }`
 */
function validateAndNormalizeQuestions(rawQuestions, defaultTimeLimit = 20) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw createHttpError(400, 'Quiz must include at least 1 valid question.');
  }
  if (rawQuestions.length > 100) {
    throw createHttpError(
      400,
      `Quiz cannot exceed 100 questions (received ${rawQuestions.length}).`
    );
  }

  const safeDefaultTime = clampInt(defaultTimeLimit, 5, 120, 20);
  const usedIds = new Set();

  return rawQuestions.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw createHttpError(400, `Question ${idx + 1} must be an object.`);
    }

    // 1. Question prompt (trimmed, non-empty, max 280 chars)
    let question = normalizeMultilineText(
      raw.question ?? raw.q ?? raw.prompt ?? raw.text ?? ''
    );
    if (!question) {
      throw createHttpError(400, `Question ${idx + 1} is missing question text.`);
    }
    if (question.length > 280) {
      question = question.slice(0, 280).trim();
    }

    // 2. Options extraction & validation
    const { options: extractedOptions, embeddedCorrectIdx } = extractRawOptions(raw);
    let options = extractedOptions.map((opt) => (opt.length > 160 ? opt.slice(0, 160).trim() : opt));

    // Auto-populate ['True', 'False'] if type is explicitly 'tf' with blank options and boolean/TF answer
    if (
      options.filter(Boolean).length === 0 &&
      (String(raw.type || '').toLowerCase() === 'tf' ||
        /^(true|false)$/i.test(String(raw.correct ?? raw.answer ?? '').trim()))
    ) {
      options = ['True', 'False'];
    }

    if (options.some((o) => !o)) {
      throw createHttpError(
        400,
        `Question ${idx + 1} ("${question.slice(0, 48)}") contains an empty answer option.`
      );
    }

    if (options.length < 2) {
      throw createHttpError(
        400,
        `Question ${idx + 1} ("${question.slice(0, 48)}") must have at least 2 answer options.`
      );
    }

    if (options.length === 3) {
      throw createHttpError(
        400,
        `Question ${idx + 1} ("${question.slice(0, 48)}") has 3 options; QuizArena questions require either 2 options (True/False) or 4 options (Multiple Choice).`
      );
    }

    // 3. Resolve correctIndex BEFORE slicing >4 options so the correct option is preserved
    let correctIndex = resolveCorrectIndex(raw, options, {
      oneBasedNumbers: Boolean(raw._oneBasedNumbers)
    });
    if (correctIndex === -1 && embeddedCorrectIdx >= 0 && embeddedCorrectIdx < options.length) {
      correctIndex = embeddedCorrectIdx;
    }

    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
      throw createHttpError(
        400,
        `Question ${idx + 1} ("${question.slice(0, 48)}") has a missing or out-of-range correct answer.`
      );
    }

    // If >4 options are provided, slice to 4 while preserving the correct option
    if (options.length > 4) {
      if (correctIndex < 4) {
        options = options.slice(0, 4);
      } else {
        const correctOption = options[correctIndex];
        options = [...options.slice(0, 3), correctOption];
        correctIndex = 3;
      }
    }

    // 4. Unique question ID
    let id = normalizeWhitespace(raw.id || '');
    if (!id || usedIds.has(id)) {
      id = `q_${idx + 1}_${crypto.randomBytes(3).toString('hex')}`;
    }
    usedIds.add(id);

    // 5. Type, timeLimit, pointsMultiplier, doublePoints, metadata
    const type = options.length === 2 ? 'tf' : 'mcq';
    const timeLimit = clampInt(raw.timeLimit ?? raw.time, 5, 120, safeDefaultTime);
    const pointsMultiplier = resolvePointsMultiplier(raw);
    const doublePoints = pointsMultiplier === 2;
    const category =
      normalizeWhitespace(raw.category ?? raw.topic ?? 'General').slice(0, 80) || 'General';
    const slideRef = normalizeWhitespace(raw.slideRef ?? '').slice(0, 120);
    const explanation = normalizeMultilineText(
      raw.explanation ?? raw.debrief ?? raw.rationale ?? raw.note ?? ''
    ).slice(0, 500);

    return {
      id,
      type,
      category,
      slideRef,
      question,
      options,
      correctIndex,
      timeLimit,
      pointsMultiplier,
      doublePoints,
      explanation
    };
  });
}

/**
 * Full RFC-4180 quote-aware CSV/TSV parser.
 * Supports double-quoted fields containing delimiters, newlines, and escaped `""` quotes.
 */
function parseDelimitedRecords(text, delimiter = ',') {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldHadQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\r') {
        if (input[i + 1] === '\n') i++;
        field += '\n';
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.trim() === '' && !fieldHadQuotes) {
      inQuotes = true;
      fieldHadQuotes = true;
      field = '';
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
      fieldHadQuotes = false;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field.trim());
      field = '';
      fieldHadQuotes = false;
      if (row.some((cell) => cell !== '')) {
        records.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }

  if (inQuotes) {
    throw createHttpError(
      400,
      'Malformed CSV/TSV input: found an unclosed double-quoted field.'
    );
  }

  if (field !== '' || fieldHadQuotes || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell !== '')) {
      records.push(row);
    }
  }

  return records;
}

const HEADER_ALIASES = {
  question: new Set(['question', 'q', 'prompt', 'questiontext', 'stem', 'title']),
  optionA: new Set(['optiona', 'opta', 'choicea', 'answera', 'a', 'option1', 'choice1', 'answer1']),
  optionB: new Set(['optionb', 'optb', 'choiceb', 'answerb', 'b', 'option2', 'choice2', 'answer2']),
  optionC: new Set(['optionc', 'optc', 'choicec', 'answerc', 'c', 'option3', 'choice3', 'answer3']),
  optionD: new Set(['optiond', 'optd', 'choiced', 'answerd', 'd', 'option4', 'choice4', 'answer4']),
  correct: new Set(['correct', 'correctanswer', 'correctoption', 'answer', 'ans', 'key']),
  correctIndex: new Set(['correctindex', 'answerindex']),
  timeLimit: new Set(['timelimit', 'time', 'seconds', 'timer', 'duration', 'timelimitsec']),
  pointsMultiplier: new Set(['multiplier', 'pointsmultiplier', 'points', 'doublepoints', 'weight', 'mode']),
  category: new Set(['category', 'topic', 'tag', 'section', 'deck']),
  explanation: new Set(['explanation', 'debrief', 'rationale', 'notes', 'note', 'feedback']),
  slideRef: new Set(['slideref', 'slide', 'reference'])
};

function normalizeHeaderKey(headerCell) {
  return String(headerCell || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function mapCsvHeaderColumns(headerRow) {
  const colMap = {};
  headerRow.forEach((cell, idx) => {
    const key = normalizeHeaderKey(cell);
    if (!key) return;
    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.has(key) && colMap[canonical] === undefined) {
        colMap[canonical] = idx;
        break;
      }
    }
  });
  const isHeader =
    colMap.question !== undefined &&
    (colMap.optionA !== undefined || colMap.correct !== undefined || colMap.correctIndex !== undefined);
  return { isHeader, colMap };
}

/**
 * Parses CSV or TSV content into raw question objects.
 *
 * `Correct` column conventions supported seamlessly:
 *  - Letter: `A`, `B`, `C`, `D` (case-insensitive; preferred export format)
 *  - 1-based option number: `1`, `2`, `3`, `4` (or `0`..`3` when header is `CorrectIndex`)
 *  - Boolean text: `True` / `False` (or `T` / `F` for 2-option True/False rows)
 *  - Exact matching option text (case-insensitive)
 *
 * For True/False rows, `OptionC` and `OptionD` may be left blank.
 */
function parseDelimitedQuiz(content, preferredDelimiter = null) {
  let delimiter = preferredDelimiter;
  if (!delimiter) {
    const firstLine = String(content).replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
    const tabCols = firstLine.split('\t').length;
    const commaCols = firstLine.split(',').length;
    delimiter = tabCols >= 4 && tabCols >= commaCols ? '\t' : ',';
  }

  const records = parseDelimitedRecords(content, delimiter);
  if (records.length === 0) {
    throw createHttpError(400, 'No rows found in CSV/TSV content.');
  }

  const { isHeader, colMap } = mapCsvHeaderColumns(records[0]);
  const dataRows = isHeader ? records.slice(1) : records;

  if (dataRows.length === 0) {
    throw createHttpError(
      400,
      'CSV/TSV file contains a header row but 0 question rows.'
    );
  }

  const rawQuestions = dataRows.map((row) => {
    const get = (idx) => (idx !== undefined && idx < row.length ? row[idx] : '');

    if (!isHeader) {
      // Positional fallback:
      // 4-5 columns: Question, OptionA, OptionB, Correct, [TimeLimit]
      // >=6 columns: Question, OptionA, OptionB, OptionC, OptionD, Correct, [TimeLimit, Multiplier, Category, Explanation]
      if (row.length >= 4 && row.length <= 5) {
        return {
          question: get(0),
          options: [get(1), get(2)],
          correct: get(3),
          timeLimit: get(4) || undefined,
          _oneBasedNumbers: true
        };
      }
      return {
        question: get(0),
        options: [get(1), get(2), get(3), get(4)],
        correct: get(5),
        timeLimit: get(6) || undefined,
        pointsMultiplier: get(7) || undefined,
        category: get(8) || undefined,
        explanation: get(9) || undefined,
        _oneBasedNumbers: true
      };
    }

    const optA = get(colMap.optionA);
    const optB = get(colMap.optionB);
    const optC = get(colMap.optionC);
    const optD = get(colMap.optionD);

    const hasZeroBasedHeader = colMap.correctIndex !== undefined && colMap.correct === undefined;
    const correctVal = hasZeroBasedHeader ? get(colMap.correctIndex) : get(colMap.correct);

    const qObj = {
      question: get(colMap.question),
      options: [optA, optB, optC, optD],
      timeLimit: get(colMap.timeLimit) || undefined,
      pointsMultiplier: get(colMap.pointsMultiplier) || undefined,
      category: get(colMap.category) || undefined,
      explanation: get(colMap.explanation) || undefined,
      slideRef: get(colMap.slideRef) || undefined,
      _oneBasedNumbers: !hasZeroBasedHeader
    };

    if (hasZeroBasedHeader && /^\d+$/.test(correctVal)) {
      qObj.correctIndex = Number(correctVal);
    } else {
      qObj.correct = correctVal;
    }

    return qObj;
  });

  return rawQuestions;
}

/**
 * Strips trailing correctness markers like ` *`, `(correct)`, `[correct]`, `✓`, `✅` from a Markdown option.
 */
function extractMarkdownOptionMarker(rawOptionText) {
  let text = String(rawOptionText || '').trim();
  let isCorrect = false;

  const suffixPatterns = [
    /\s+\((?:correct|right|answer)\)\s*$/i,
    /\s+\[(?:correct|right|answer|x)\]\s*$/i,
    /\s+(?:✅|✓|✔)\s*$/,
    /(?:^|\s)\*\s*$/ // trailing single `*` (not `**bold**` since `**` doesn't match `(?:^|\s)\*$`)
  ];

  for (const re of suffixPatterns) {
    if (re.test(text) && !/\*\*$/.test(text)) {
      isCorrect = true;
      text = text.replace(re, '').trim();
    }
  }

  return { text, isCorrect };
}

/**
 * Extracts inline tags from a Markdown question heading, e.g. `[2x]`, `(Boss)`, `[Poll]`, `[30s]`.
 */
function extractInlineQuestionMeta(rawStem) {
  let stem = String(rawStem || '').trim();
  let timeLimit;
  let pointsMultiplier;

  stem = stem.replace(/\s*[\[(](\d{1,3})\s*s(?:ec(?:ond)?s?)?[\])]/gi, (_m, sec) => {
    timeLimit = Number(sec);
    return '';
  });

  stem = stem.replace(/\s*[\[(](2x|boss(?:\s+round)?|double(?:\s+points)?)[\])]/gi, () => {
    pointsMultiplier = 2;
    return '';
  });

  stem = stem.replace(/\s*[\[(](0x|poll)[\])]/gi, () => {
    pointsMultiplier = 0;
    return '';
  });

  // Strip surrounding bold markers if entire question stem was **bold**
  stem = stem.replace(/^\*\*(.+)\*\*$/, '$1').trim();

  return { question: stem, timeLimit, pointsMultiplier };
}

/**
 * Parses Markdown Q&A blocks supporting:
 *  - `# Quiz Title` + optional intro description
 *  - `## 1. Question`, `1. Question`, `1) Question`, `Q: Question`, `Q1: Question`
 *  - `- [x] Correct` / `- [ ] Wrong` checkboxes
 *  - `A) Option *` / `B. Option` + `Answer: B`
 *  - Optional `Explanation: ...`, `Category: ...`, `Time: ...`, `Multiplier: ...`
 */
function parseMarkdownQuiz(content) {
  const lines = String(content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  let docTitle = '';
  let docDescription = '';
  const blocks = [];
  let current = null;

  const flushCurrent = () => {
    if (!current) return;
    if (current.question && (current.options.length > 0 || current.explicitAnswer)) {
      const qObj = {
        question: current.question,
        options: current.options,
        explanation: current.explanation,
        category: current.category,
        timeLimit: current.timeLimit,
        pointsMultiplier: current.pointsMultiplier,
        _oneBasedNumbers: true
      };
      if (current.explicitAnswer) {
        qObj.correct = current.explicitAnswer;
      } else if (current.markedCorrectIndex !== -1) {
        qObj.correctIndex = current.markedCorrectIndex;
      }
      blocks.push(qObj);
    }
    current = null;
  };

  const startQuestion = (rawStem) => {
    flushCurrent();
    const meta = extractInlineQuestionMeta(rawStem);
    current = {
      question: meta.question,
      options: [],
      markedCorrectIndex: -1,
      explicitAnswer: '',
      explanation: '',
      category: '',
      timeLimit: meta.timeLimit,
      pointsMultiplier: meta.pointsMultiplier
    };
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) continue;

    // Horizontal rule separates blocks
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushCurrent();
      continue;
    }

    // Top-level H1 title (`# Quiz Title`) before questions start
    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match && !current && blocks.length === 0 && !docTitle) {
      docTitle = h1Match[1].trim();
      continue;
    }

    // Metadata lines inside an active question block (`Answer:`, `Explanation:`, `Category:`, `Time:`, `Multiplier:`)
    if (current) {
      const ansMatch = line.match(
        /^(?:>\s*)?(?:\*\*|__)?(?:correct\s+answer|correct\s+option|correct|answer|ans)(?:\*\*|__)?\s*[:\-]\s*(.+)$/i
      );
      if (ansMatch) {
        current.explicitAnswer = ansMatch[1].replace(/^\*\*|\*\*$/g, '').trim();
        continue;
      }

      const expMatch = line.match(
        /^(?:>\s*)?(?:\*\*|__)?(?:explanation|rationale|debrief|note|feedback)(?:\*\*|__)?\s*[:\-]\s*(.+)$/i
      );
      if (expMatch) {
        current.explanation = expMatch[1].trim();
        continue;
      }

      const catMatch = line.match(
        /^(?:>\s*)?(?:\*\*|__)?(?:category|topic|tag)(?:\*\*|__)?\s*[:\-]\s*(.+)$/i
      );
      if (catMatch) {
        current.category = catMatch[1].trim();
        continue;
      }

      const timeMatch = line.match(
        /^(?:>\s*)?(?:\*\*|__)?(?:time(?:\s*limit)?|timer|seconds)(?:\*\*|__)?\s*[:\-]\s*(\d+)\s*s?$/i
      );
      if (timeMatch) {
        current.timeLimit = Number(timeMatch[1]);
        continue;
      }

      const multMatch = line.match(
        /^(?:>\s*)?(?:\*\*|__)?(?:multiplier|points(?:\s*multiplier)?|mode)(?:\*\*|__)?\s*[:\-]\s*(.+)$/i
      );
      if (multMatch) {
        current.pointsMultiplier = multMatch[1].trim();
        continue;
      }
    }

    // Checkbox option: `- [x] Option` or `- [ ] Option`
    const checkboxMatch = line.match(/^[-*+]\s*\[([xX✓✔\s]?)\]\s*(.+)$/);
    if (checkboxMatch && current) {
      const marked = /[xX✓✔]/.test(checkboxMatch[1]);
      const parsedOpt = extractMarkdownOptionMarker(checkboxMatch[2]);
      if ((marked || parsedOpt.isCorrect) && current.markedCorrectIndex === -1) {
        current.markedCorrectIndex = current.options.length;
      }
      current.options.push(parsedOpt.text);
      continue;
    }

    // Lettered option: `A) Option`, `A. Option`, `- A) Option`, `(A) Option`, `**A)** Option`
    const letterOptMatch = line.match(
      /^(?:[-*+]\s+)?(?:\*\*|__)?\(?([A-Fa-f])(?:\)|\.|:)(?:\*\*|__)?\s+(.+)$/
    );
    // Avoid confusing `Q:` (handled by Q regex since `Q` is not in `A-F`)
    if (letterOptMatch && current) {
      const parsedOpt = extractMarkdownOptionMarker(letterOptMatch[2]);
      if (parsedOpt.isCorrect && current.markedCorrectIndex === -1) {
        current.markedCorrectIndex = current.options.length;
      }
      current.options.push(parsedOpt.text);
      continue;
    }

    // Question starters:
    // 1. Markdown heading `## ...` / `### ...`
    const headingQMatch = line.match(
      /^#{2,5}\s+(?:(?:question|q)\s*\d*\s*[:.)\-]\s*|\d+\s*[.)\-]\s*)?(.+)$/i
    );
    if (headingQMatch) {
      startQuestion(headingQMatch[1]);
      continue;
    }

    // 2. Explicit `Q:` / `Q1:` / `Question 1:`
    const qPrefixMatch = line.match(
      /^(?:\*\*|__)?(?:question|q)\s*\d*(?:\*\*|__)?\s*[:.)\-]\s*(.+)$/i
    );
    if (qPrefixMatch) {
      startQuestion(qPrefixMatch[1]);
      continue;
    }

    // 3. Numbered question `1. What is...` or `1) What is...`
    const numQMatch = line.match(/^(?:\*\*|__)?(\d+)\s*[.)](?:\*\*|__)?\s+(.+)$/);
    if (numQMatch) {
      startQuestion(numQMatch[2]);
      continue;
    }

    // 4. Plain bullet option `- Option` / `* Option` inside an active question
    const bulletOptMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletOptMatch && current) {
      const parsedOpt = extractMarkdownOptionMarker(bulletOptMatch[1]);
      if (parsedOpt.isCorrect && current.markedCorrectIndex === -1) {
        current.markedCorrectIndex = current.options.length;
      }
      current.options.push(parsedOpt.text);
      continue;
    }

    // 5. Unnumbered question line (if no question open yet, or previous question already has >=2 options + answer/explanation)
    const prevComplete =
      current &&
      current.options.length >= 2 &&
      (current.markedCorrectIndex !== -1 || Boolean(current.explicitAnswer));
    if (!current || prevComplete) {
      // Peek ahead to see if next non-empty line looks like an option
      let nextNonEmpty = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          nextNonEmpty = lines[j].trim();
          break;
        }
      }
      const nextLooksLikeOption =
        /^[-*+]\s*\[/.test(nextNonEmpty) ||
        /^(?:[-*+]\s+)?(?:\*\*|__)?\(?[A-Da-d](?:\)|\.|:)/.test(nextNonEmpty) ||
        /^[-*+]\s+/.test(nextNonEmpty);

      if (nextLooksLikeOption) {
        startQuestion(line);
        continue;
      }

      if (!current && blocks.length === 0 && !docDescription) {
        docDescription = line;
        continue;
      }
    }

    // Multi-line continuation of question stem if options haven't started yet
    if (current && current.options.length === 0 && !current.explanation) {
      current.question = `${current.question} ${line}`.trim();
    }
  }

  flushCurrent();

  return {
    title: docTitle,
    description: docDescription,
    questions: blocks
  };
}

/**
 * Auto-detects format ('json' | 'tsv' | 'csv' | 'markdown') when format === 'auto'.
 */
function detectQuizFormat(content) {
  const trimmed = String(content ?? '').replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'markdown';

  const firstLine = lines[0];

  // Check if first line is a recognizable CSV or TSV header
  const tabHeader = mapCsvHeaderColumns(firstLine.split('\t'));
  if (tabHeader.isHeader) return 'tsv';

  const commaHeader = mapCsvHeaderColumns(firstLine.split(','));
  if (commaHeader.isHeader) return 'csv';

  // Check for Markdown structural indicators before trying headerless CSV/TSV
  const hasMarkdownIndicators = lines.some(
    (l) =>
      /^#{1,4}\s+/.test(l) ||
      /^[-*+]\s*\[[xX✓✔\s]?\]/.test(l) ||
      /^(?:[-*+]\s+)?\(?[A-Da-d](?:\)|\.)\s+/.test(l) ||
      /^(?:answer|correct|explanation)\s*:/i.test(l) ||
      /^(?:question|q)\s*\d*\s*:/i.test(l)
  );
  if (hasMarkdownIndicators) {
    return 'markdown';
  }

  // Headerless TSV / CSV check: consistent >=4 columns across initial records
  try {
    const tabRecords = parseDelimitedRecords(trimmed, '\t');
    if (tabRecords.length >= 1 && tabRecords.every((r) => r.length >= 4)) {
      return 'tsv';
    }
  } catch (_err) {
    // Not valid TSV
  }

  try {
    const csvRecords = parseDelimitedRecords(trimmed, ',');
    if (csvRecords.length >= 1 && csvRecords.every((r) => r.length >= 4)) {
      return 'csv';
    }
  } catch (_err) {
    // Not valid CSV
  }

  return 'markdown';
}

/**
 * Multi-format quiz importer supporting JSON, CSV, TSV, and Markdown (plus `auto` detection).
 * Returns `{ title, description, coverEmoji: '📝', questions: normalizedQuestions }`,
 * or throws an `Error` with `.status = 400` if 0 valid questions were parsed.
 */
function importQuizFromText(params = {}) {
  const { format = 'auto', content } = params;
  const callerProvidedTitle =
    params.title !== undefined &&
    params.title !== null &&
    String(params.title).trim() !== '' &&
    params.title !== 'Imported Quiz'
      ? String(params.title).trim()
      : '';
  const fallbackTitle =
    params.title !== undefined && String(params.title).trim() !== ''
      ? String(params.title).trim()
      : 'Imported Quiz';

  const rawText = String(content ?? '').replace(/^\uFEFF/, '').trim();
  if (!rawText) {
    throw createHttpError(
      400,
      'Quiz import content is empty. Paste CSV, JSON, or Markdown questions to import.'
    );
  }

  const fmtRaw = String(format || 'auto').trim().toLowerCase();
  let resolvedFormat;
  if (fmtRaw === 'auto' || fmtRaw === '') {
    resolvedFormat = detectQuizFormat(rawText);
  } else if (fmtRaw === 'json') {
    resolvedFormat = 'json';
  } else if (fmtRaw === 'tsv') {
    resolvedFormat = 'tsv';
  } else if (fmtRaw === 'csv' || fmtRaw === 'csv/tsv' || fmtRaw === 'csv_tsv') {
    // If user selected "CSV / TSV" in Studio UI and pasted tab-separated rows, auto-pick '\t' vs ','
    const firstLine = rawText.split(/\r?\n/)[0] || '';
    resolvedFormat =
      firstLine.split('\t').length >= 4 && firstLine.split('\t').length > firstLine.split(',').length
        ? 'tsv'
        : 'csv';
  } else if (fmtRaw === 'markdown' || fmtRaw === 'md') {
    resolvedFormat = 'markdown';
  } else {
    throw createHttpError(
      400,
      `Unsupported import format "${format}". Supported formats: auto, csv, tsv, json, markdown.`
    );
  }

  let rawQuestions = [];
  let detectedTitle = '';
  let detectedDescription = '';
  let coverEmoji = '📝';

  if (resolvedFormat === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw createHttpError(
        400,
        `Could not parse JSON quiz content: ${err.message}`
      );
    }

    if (Array.isArray(parsed)) {
      rawQuestions = parsed;
    } else if (parsed && typeof parsed === 'object') {
      detectedTitle = normalizeWhitespace(parsed.title || '');
      detectedDescription = normalizeMultilineText(parsed.description || '');
      if (parsed.coverEmoji && normalizeWhitespace(parsed.coverEmoji)) {
        coverEmoji = normalizeWhitespace(parsed.coverEmoji);
      }
      if (Array.isArray(parsed.questions)) {
        rawQuestions = parsed.questions;
      } else if (Array.isArray(parsed.items)) {
        rawQuestions = parsed.items;
      } else {
        throw createHttpError(
          400,
          'JSON quiz object must contain a "questions" array.'
        );
      }
    } else {
      throw createHttpError(
        400,
        'JSON quiz input must be a quiz object or an array of questions.'
      );
    }
  } else if (resolvedFormat === 'csv' || resolvedFormat === 'tsv') {
    rawQuestions = parseDelimitedQuiz(rawText, resolvedFormat === 'tsv' ? '\t' : ',');
  } else {
    const mdResult = parseMarkdownQuiz(rawText);
    detectedTitle = mdResult.title;
    detectedDescription = mdResult.description;
    rawQuestions = mdResult.questions;
  }

  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw createHttpError(
      400,
      `Could not find any valid questions in the ${resolvedFormat.toUpperCase()} input. Check your formatting or download the sample CSV template.`
    );
  }

  if (rawQuestions.length > 100) {
    rawQuestions = rawQuestions.slice(0, 100);
  }

  const normalizedQuestions = validateAndNormalizeQuestions(rawQuestions, 20);
  const finalTitle = (callerProvidedTitle || detectedTitle || fallbackTitle).slice(0, 120);
  const finalDescription = (
    detectedDescription ||
    `Imported ${normalizedQuestions.length} question${normalizedQuestions.length === 1 ? '' : 's'} via ${resolvedFormat.toUpperCase()}.`
  ).slice(0, 300);

  return {
    title: finalTitle,
    description: finalDescription,
    coverEmoji,
    questions: normalizedQuestions
  };
}

function escapeCsvCell(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exports a quiz object (or questions array) to a clean UTF-8 RFC-4180 CSV string.
 * Header: `Question,OptionA,OptionB,OptionC,OptionD,Correct,TimeLimit,Multiplier,Category,Explanation`
 */
function exportQuizToCsv(quiz) {
  const questions = Array.isArray(quiz)
    ? quiz
    : quiz && Array.isArray(quiz.questions)
      ? quiz.questions
      : [];

  const lines = [CSV_HEADERS.join(',')];
  const letters = ['A', 'B', 'C', 'D'];

  for (const q of questions) {
    const opts = Array.isArray(q.options) ? q.options : [];
    const isTwoChoice = opts.length === 2;
    const correctIdx = Number.isInteger(q.correctIndex) ? q.correctIndex : 0;
    const correctLetter = letters[correctIdx] || 'A';
    const timeLimit = clampInt(q.timeLimit, 5, 120, 20);
    const multiplier =
      q.pointsMultiplier !== undefined
        ? resolvePointsMultiplier(q)
        : q.doublePoints
          ? 2
          : 1;

    const row = [
      q.question || '',
      opts[0] || '',
      opts[1] || '',
      isTwoChoice ? '' : opts[2] || '',
      isTwoChoice ? '' : opts[3] || '',
      correctLetter,
      String(timeLimit),
      String(multiplier),
      q.category || 'General',
      q.explanation || ''
    ];
    lines.push(row.map(escapeCsvCell).join(','));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Returns a 3-row ready-to-edit sample CSV (2 MCQs + 1 True/False) downloadable from Creator Studio.
 */
function getSampleCsvTemplate() {
  const sampleQuestions = [
    {
      question: 'Which HTTP status code indicates a request was rate-limited by an API gateway?',
      options: ['401 Unauthorized', '403 Forbidden', '429 Too Many Requests', '503 Service Unavailable'],
      correctIndex: 2,
      timeLimit: 20,
      pointsMultiplier: 1,
      category: 'Cloud & APIs',
      explanation: 'HTTP 429 signals the client has sent too many requests in a given window and should back off.'
    },
    {
      question: 'Why does Context Caching lower cost and latency in multi-turn LLM workflows?',
      options: [
        'It skips safety filters on repeated prompts',
        'It reuses precomputed KV-cache tokens across requests',
        'It shrinks model parameters from FP16 to INT4',
        'It disables output token billing automatically'
      ],
      correctIndex: 1,
      timeLimit: 25,
      pointsMultiplier: 2,
      category: 'GenAI Architecture',
      explanation: 'Caching shared system prompts or documents avoids recomputing prompt attention on every turn.'
    },
    {
      question: 'Cloud Run services can automatically scale down to zero instances when idle.',
      options: ['True', 'False'],
      correctIndex: 0,
      timeLimit: 15,
      pointsMultiplier: 1,
      category: 'Serverless',
      explanation: 'By default, Cloud Run scales down to zero instances when no requests are active unless min-instances is configured.'
    }
  ];

  return exportQuizToCsv({ questions: sampleQuestions });
}

/**
 * Acquires a Google Cloud ADC Bearer token using zero extra npm dependencies:
 *  1) GCE / Cloud Run Metadata Server (1.5s timeout), cached until 60s before expiry.
 *  2) Fallback on local dev machines to `gcloud auth application-default print-access-token`
 *     or `gcloud auth print-access-token` (cached for 45 minutes).
 */
async function getVertexAccessToken({ forceGcloudFallback = false } = {}) {
  if (
    !forceGcloudFallback &&
    cachedToken &&
    Date.now() < cachedTokenExpiresAt
  ) {
    return { token: cachedToken, source: cachedTokenSource };
  }

  if (!forceGcloudFallback && process.env.GOOGLE_ACCESS_TOKEN) {
    cachedToken = process.env.GOOGLE_ACCESS_TOKEN.trim();
    cachedTokenExpiresAt = Date.now() + 10 * 60 * 1000;
    cachedTokenSource = 'env';
    return { token: cachedToken, source: 'env' };
  }

  // 1) Try GCE / Cloud Run metadata server first
  if (!forceGcloudFallback) {
    try {
      const res = await fetch(METADATA_TOKEN_URL, {
        method: 'GET',
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(1500)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.access_token === 'string' && data.access_token.trim()) {
          const expiresInSec = Number(data.expires_in) || 3600;
          const ttlMs = Math.max(5, expiresInSec - 60) * 1000;
          cachedToken = data.access_token.trim();
          cachedTokenExpiresAt = Date.now() + ttlMs;
          cachedTokenSource = 'metadata';
          return { token: cachedToken, source: 'metadata' };
        }
      }
    } catch (_err) {
      // Expected outside Cloud Run / GCE; fall through to gcloud CLI
    }
  }

  // 2) Local dev fallback: gcloud ADC or user credentials (cached for 45 mins)
  const gcloudCommands = [
    ['auth', 'application-default', 'print-access-token'],
    ['auth', 'print-access-token']
  ];

  for (const args of gcloudCommands) {
    try {
      const out = execFileSync('gcloud', args, {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
      if (out) {
        cachedToken = out;
        cachedTokenExpiresAt = Date.now() + GCLOUD_CACHE_TTL_MS;
        cachedTokenSource = 'gcloud';
        return { token: cachedToken, source: 'gcloud' };
      }
    } catch (_err) {
      // Try next fallback
    }
  }

  throw createHttpError(
    503,
    'Unable to obtain Google Cloud credentials for AI Quiz Generation. Run `gcloud auth application-default login` locally or attach a Vertex AI service account on Cloud Run.'
  );
}

/**
 * Generates a structured Kahoot-style quiz using Vertex AI `gemini-3.8-flash` (`locations/global`).
 */
async function generateQuizWithAI(options = {}) {
  const {
    prompt = '',
    sourceText = '',
    questionCount = 10,
    difficulty = 'medium',
    includeTrueFalse = false
  } = options;

  const cleanPrompt = normalizeWhitespace(prompt);
  const cleanSource = String(sourceText ?? '').trim().slice(0, MAX_SOURCE_TEXT_CHARS);

  if (!cleanPrompt && !cleanSource) {
    throw createHttpError(
      400,
      'Please provide a quiz topic/prompt or paste source notes to generate questions.'
    );
  }

  const count = clampInt(questionCount, 3, 25, 10);
  const diffNormalized = ['easy', 'medium', 'hard'].includes(
    String(difficulty || '').toLowerCase()
  )
    ? String(difficulty).toLowerCase()
    : 'medium';
  const allowTF = Boolean(includeTrueFalse);
  const bossCount = count >= 8 ? 2 : 1;
  const tfTarget = allowTF ? Math.max(1, Math.min(Math.round(count * 0.25), 6)) : 0;

  const projectId = resolveProjectId();
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/locations/global/publishers/google/models/${VERTEX_MODEL_ID}:generateContent`;

  const systemPrompt = [
    'You are an expert live-game quiz designer creating high-energy multiplayer Kahoot-style quizzes for QuizArena.',
    'Follow these strict Kahoot authoring rules:',
    '1. Crisp, scannable questions: EVERY question MUST be < 140 characters, direct, clear, and standalone.',
    '2. Concise, balanced options: EVERY option MUST be < 65 characters. Distractors must be plausible and match the length, specificity, and grammar of the correct option (NEVER make the correct answer the longest or odd-one-out!).',
    '3. Zero document/slide references: NEVER write "According to Slide 3", "In the passage", or "As mentioned in the notes". Frame all questions as standalone domain knowledge.',
    '4. Balanced answer keys: Distribute `correctIndex` evenly across 0, 1, 2, and 3 for MCQs (and across 0 and 1 for True/False).',
    `5. Boss Rounds: Mark ${bossCount} of the most synthesis-oriented question(s) (near the end of the quiz) with "pointsMultiplier": 2; set "pointsMultiplier": 1 on all other questions.`,
    '6. Facilitator debrief: Give every question a crisp, insightful 1-sentence `explanation` (< 180 chars) teaching why the answer is right.',
    allowTF
      ? `7. Question types: Generate ${count - tfTarget} four-option MCQs (exactly 4 options each) and ${tfTarget} True/False question(s) with options ["True", "False"] and correctIndex 0 or 1.`
      : '7. Question types: EVERY question MUST be a 4-option Multiple Choice question with `options` containing EXACTLY 4 strings (do NOT generate 2-option True/False questions).',
    '8. Return ONLY valid JSON matching the requested schema.'
  ].join('\n');

  const userParts = [
    `Generate a ${diffNormalized}-difficulty live quiz with EXACTLY ${count} questions.`
  ];
  if (cleanPrompt) {
    userParts.push(`Topic / Instructions:\n${cleanPrompt}`);
  }
  if (cleanSource) {
    userParts.push(
      `Source Material / Notes (extract key concepts without referencing "the text" or slide numbers):\n"""\n${cleanSource}\n"""`
    );
  }
  userParts.push(
    `Output JSON schema:\n` +
      `{\n` +
      `  "title": "Engaging Quiz Title (< 70 chars)",\n` +
      `  "description": "1-sentence summary (< 160 chars)",\n` +
      `  "coverEmoji": "⚡",\n` +
      `  "questions": [\n` +
      `    {\n` +
      `      "category": "Short Topic Tag",\n` +
      `      "question": "Crisp question (< 140 chars)?",\n` +
      `      "options": ["Option A", "Option B", "Option C", "Option D"],\n` +
      `      "correctIndex": 0,\n` +
      `      "timeLimit": 20,\n` +
      `      "pointsMultiplier": 1,\n` +
      `      "explanation": "1-sentence takeaway."\n` +
      `    }\n` +
      `  ]\n` +
      `}`
  );

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userParts.join('\n\n') }]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
      thinkingConfig: {
        thinkingLevel: 'LOW'
      }
    }
  };

  let authInfo = await getVertexAccessToken();
  let response;

  const sendVertexRequest = async (bearerToken) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(25000)
    });

  try {
    response = await sendVertexRequest(authInfo.token);
    // If a GCE VM metadata token lacked Vertex AI scope on local dev, retry once with gcloud ADC
    if ((response.status === 401 || response.status === 403) && authInfo.source === 'metadata' && !process.env.K_SERVICE) {
      cachedToken = null;
      cachedTokenExpiresAt = 0;
      authInfo = await getVertexAccessToken({ forceGcloudFallback: true });
      response = await sendVertexRequest(authInfo.token);
    }
  } catch (err) {
    throw createHttpError(
      502,
      `Vertex AI request failed or timed out: ${err.message}`
    );
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw createHttpError(
      502,
      `Vertex AI gemini-3.8-flash returned HTTP ${response.status}: ${errText.slice(0, 240)}`
    );
  }

  const payload = await response.json();
  const parts =
    payload?.candidates?.[0]?.content?.parts || [];
  // Filter out internal thought parts (`part.thought === true`) when thinkingConfig is active
  const jsonText = parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!jsonText) {
    throw createHttpError(
      502,
      'Vertex AI returned an empty quiz generation response. Please try again.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw createHttpError(
      502,
      `AI generated invalid JSON output: ${err.message}`
    );
  }

  const rawQuestions = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.questions)
      ? parsed.questions
      : [];

  if (rawQuestions.length === 0) {
    throw createHttpError(
      502,
      'AI response did not include any quiz questions. Try a clearer topic prompt.'
    );
  }

  const normalizedQuestions = validateAndNormalizeQuestions(
    rawQuestions.slice(0, count),
    20
  );

  const title =
    normalizeWhitespace(parsed?.title || cleanPrompt || 'AI Generated Quiz').slice(0, 120) ||
    'AI Generated Quiz';
  const description =
    normalizeMultilineText(
      parsed?.description ||
        `${normalizedQuestions.length}-question ${diffNormalized} quiz generated with Gemini 3.8 Flash.`
    ).slice(0, 300);
  const coverEmoji = normalizeWhitespace(parsed?.coverEmoji || '✨') || '✨';

  return {
    title,
    description,
    coverEmoji,
    questions: normalizedQuestions
  };
}

module.exports = {
  validateAndNormalizeQuestions,
  importQuizFromText,
  exportQuizToCsv,
  getSampleCsvTemplate,
  generateQuizWithAI
};
