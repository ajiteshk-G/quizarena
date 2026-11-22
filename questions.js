// 30 Practical, Approachable Kahoot Questions (UC1: GenAI Architecture & FinOps | UC2: Production Agents, Security & Observability)
// Crisp, scannable, fun for a 100-person workshop (~65-80% target accuracy) with plausible distractors and zero slide references.

const QUESTIONS = [
  // ==================== UC1: GENAI ARCHITECTURE, SERVING, EVALS & FINOPS ====================
  {
    id: 'uc1-1',
    deck: 'UC1',
    category: 'Batch vs. Live Design',
    slideRef: 'Workload Decomposition',
    question: 'For a 10M-user personalized campaign, why generate product assets offline per SKU instead of live per user?',
    options: [
      'Offline batch jobs run with zero hallucination risk',
      'It cuts GenAI calls from millions down to thousands of reusable assets',
      'Live APIs cannot generate images or marketing copy',
      'Offline jobs automatically skip all quality checks'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Pre-computing reusable assets offline per SKU decouples GenAI cost and quota from total user count—letting existing ranking and delivery systems scale cheaply.'
  },
  {
    id: 'uc1-2',
    deck: 'UC1',
    category: 'Pricing Tiers',
    slideRef: 'Batch & Flex Discounts',
    question: 'Roughly how much cheaper are Batch and Flex inference tiers compared to Standard on-demand pricing?',
    options: [
      '15% off',
      '25% off',
      '50% off',
      '80% off'
    ],
    correctIndex: 2,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Latency is a SKU: Batch and Flex tiers offer 50% off (0.5×) when async turnaround fits your workflow, while Standard is 1× and Priority is 1.8×.'
  },
  {
    id: 'uc1-3',
    deck: 'UC1',
    category: 'Capacity Strategy',
    slideRef: 'Provisioned Throughput vs. Batch',
    question: 'When does buying Provisioned Throughput (PT) make the most financial sense?',
    options: [
      'For a spiky 2-hour nightly batch job',
      'For a steady, predictable live daytime traffic baseline',
      'For one-off quarterly data migrations',
      'For small dev/test prototypes with low traffic'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Buy by traffic shape: PT pays off under steady, predictable interactive baselines—never pay 24/7 for PT to serve a short nightly batch (use Flex/Batch instead).'
  },
  {
    id: 'uc1-4',
    deck: 'UC1',
    category: 'GPU Serving',
    slideRef: 'Quantization (BF16 → FP8)',
    question: 'What is the main benefit of quantizing an open-weight model from BF16 to FP8 on modern GPUs?',
    options: [
      'It doubles the model\'s parameter count',
      'It cuts model weight VRAM in half, leaving more room for concurrent users',
      'It removes the need for a GPU entirely',
      'It increases output accuracy by 20%'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'FP8 shrinks static weights by 50% with <1% quality delta—freeing GPU memory directly for the KV-cache so you can serve far more concurrent requests.'
  },
  {
    id: 'uc1-5',
    deck: 'UC1',
    category: 'Context Caching',
    slideRef: 'Prompt Reuse & Savings',
    question: 'Which workload benefits MOST from Context Caching?',
    options: [
      'Short, unique one-line queries with no shared instructions',
      'Repeated requests sharing a large system prompt, catalog, or document',
      'Generating random 8-second videos from scratch',
      'One-time offline model weight downloads'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Context Caching avoids paying full price to re-process the same large prompt prefix over and over—delivering up to 75–90% savings on cached input tokens.'
  },
  {
    id: 'uc1-6',
    deck: 'UC1',
    category: 'Model Selection',
    slideRef: 'Commercial License Checks',
    question: 'Why should teams check an open-weight model\'s license BEFORE running quality benchmarks?',
    options: [
      'Non-commercial licenses disqualify the model for production immediately',
      'Open-weight models cannot run on Kubernetes',
      'Checking licenses improves GPU inference speed',
      'Benchmarks are legally restricted to proprietary models'
    ],
    correctIndex: 0,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Paper elimination takes minutes while a late licensing surprise costs weeks—non-commercial weights (like FLUX.2 [dev] or IDM-VTON) must be filtered out on Day 1.'
  },
  {
    id: 'uc1-7',
    deck: 'UC1',
    category: 'Model Routing',
    slideRef: 'Cheap-First Cascade',
    question: 'How does a "cheap-first cascade" reduce AI serving cost while protecting quality?',
    options: [
      'Runs the largest model on every request, then verifies with a small model',
      'Runs a fast, low-cost model first and escalates only uncertain cases to a frontier model',
      'Randomly sends 50% of traffic to a smaller model without checking quality',
      'Turns off safety filters on low-priority requests'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'A cheap-first cascade handles the easy 80% with a fast, inexpensive model and escalates only the tricky 20% to a frontier model—cutting spend dramatically.'
  },
  {
    id: 'uc1-8',
    deck: 'UC1',
    category: 'Product KPIs',
    slideRef: 'Balancing Clicks & Returns',
    question: 'Why should a retail Virtual Try-On feature track product return rate alongside click-through rate (CTR)?',
    options: [
      'High CTR automatically triggers cloud quota limits',
      'Overly flattering renders can boost clicks while misleading buyers and spiking returns',
      'Return rates are required to train image diffusion models',
      'CTR cannot be measured on mobile devices'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Always pair engagement KPIs with business outcomes: if generated images distort garment fit, clicks go up while returns quietly wipe out net margin.'
  },
  {
    id: 'uc1-9',
    deck: 'UC1',
    category: 'Retry Economics',
    slideRef: 'Bounding Retry Spend',
    question: 'Why does "happy-path pricing" (1 call per item) often underestimate real production AI bills?',
    options: [
      'Cloud providers double prices during weekends',
      'Failed generations trigger retries and QA calls that multiply real spend and quota',
      'Token pricing increases linearly with every API call',
      'Batch APIs charge extra for successful responses'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Real cost = Base Call × (1 + Retry Rate) + QA/escalation costs. Cap retries (e.g., Max 1) before falling back to a clean template.'
  },
  {
    id: 'uc1-10',
    deck: 'UC1',
    category: 'Quota Math',
    slideRef: 'Peak RPM vs. Daily Volume',
    question: 'Why can a pipeline fit easily inside its daily token budget yet still fail with HTTP 429 rate-limit errors?',
    options: [
      'Daily budgets only count output tokens, not input tokens',
      'Quotas are enforced per minute (RPM/TPM), so short burst windows exceed limits',
      'HTTP 429 means the GPU ran out of disk space',
      'Rate limits only apply when Context Caching is enabled'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'RPM > Daily Volume! Always size against your active render window (minutes) including retries, not a 24-hour average.'
  },
  {
    id: 'uc1-11',
    deck: 'UC1',
    category: 'Optimization Priority',
    slideRef: 'Routing vs. Fine-Tuning',
    question: 'When a GenAI app has quality issues, why is fine-tuning (LoRA) rarely the FIRST fix to try?',
    options: [
      'Fine-tuned models cannot be deployed on Google Cloud',
      'Fixing prompts, routing, and evals takes minutes/days, while fine-tuning takes months and can regress',
      'Fine-tuning disables JSON structured outputs',
      'LoRA adapters only work on audio models'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Fix the router in minutes, the evaluator in days, and the model in months. Exhaust prompt, retrieval, and routing improvements before committing to fine-tuning.'
  },
  {
    id: 'uc1-12',
    deck: 'UC1',
    category: 'Scalable QA',
    slideRef: 'Automated Judge + Human Sampling',
    question: 'How do high-volume generative pipelines maintain quality without having humans review 100% of outputs?',
    options: [
      'Skip QA completely once the model passes unit tests',
      'Use automated checks + an AI judge, and have humans audit flagged items plus a daily sample',
      'Ask end customers to grade every image before checkout',
      'Run the exact same prompt twice and pick the longer output'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Layered QA (fast rule/CV pre-gate → AI judge → human review of flagged items + a bounded daily sample of auto-approved items) scales cleanly with headcount.'
  },
  {
    id: 'uc1-13',
    deck: 'UC1',
    category: 'Discount Rules',
    slideRef: 'Batch API × Context Caching',
    question: 'If you use both Batch API (50% off) and Context Caching (90% off) together, what discount applies to cached input tokens?',
    options: [
      '95% off (both discounts stack)',
      '50% off (Batch caps the discount)',
      '90% off (they do not stack; the bigger discount wins)',
      '0% off (they cancel each other out)'
    ],
    correctIndex: 2,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Batch and Context Caching discounts do not stack—the 90% context-cache discount wins on cached tokens.'
  },
  {
    id: 'uc1-14',
    deck: 'UC1',
    category: 'Prefix Caching on GKE',
    slideRef: 'Cache-Aware Load Balancing',
    question: 'Why does prefix-aware routing beat simple round-robin load balancing for self-hosted LLM replicas?',
    options: [
      'It sends requests with matching prompt prefixes to the same warm KV-cache replica',
      'It compresses model weights automatically across nodes',
      'It doubles the network bandwidth between pods',
      'It eliminates the need for health checks'
    ],
    correctIndex: 0,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Round-robin scatters identical system prompts across cold replicas. Prefix-aware routing keeps matching prefixes hitting warm KV caches (~89% hit rates).'
  },
  {
    id: 'uc1-15',
    deck: 'UC1',
    category: 'FinOps Golden Rule',
    slideRef: 'Cutting AI Spend',
    question: 'BOSS QUESTION (2×): What is the #1 first step to cut production AI spend without hurting quality?',
    options: [
      'Negotiate committed-use discounts first',
      'Eliminate unnecessary calls & volume first, then tier models, then discount price last',
      'Move everything to Priority PayGo immediately',
      'Shrink all prompts to under 50 words'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: true,
    explanation: 'Every call you eliminate saves 100% of compute, judge, and human review costs. Cut volume first, tier/cascade models second, and discount unit price last.'
  },

  // ==================== UC2: PRODUCTION AGENTS — HARNESS, SECURITY, EVALS & OBSERVABILITY ====================
  {
    id: 'uc2-1',
    deck: 'UC2',
    category: 'Agent Security Basics',
    slideRef: 'Chatbot vs. Agent Risk',
    question: 'Why is securing an AI Agent fundamentally higher-stakes than securing a standard Q&A chatbot?',
    options: [
      'Agents always use larger models with more parameters',
      'A chatbot only says things; an agent calls tools and takes real actions',
      'Chatbots run offline while agents require public IPs',
      'Agents cannot use HTTPS encryption'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Tools turn words into real-world actions (refunds, emails, database writes)—which is why agents need Zero Trust guardrails, least-privilege tools, and approvals.'
  },
  {
    id: 'uc2-2',
    deck: 'UC2',
    category: 'Blast Radius',
    slideRef: 'Least-Privilege Tooling',
    question: 'What is the simplest, most foolproof way to prevent an agent from performing a dangerous action?',
    options: [
      'Ask it politely in the system prompt not to do it',
      'Do not give the agent a tool for that action in the first place',
      'Set temperature to 0.1',
      'Log every tool call to Cloud Logging'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Draw the blast radius before you draw the graph: if the agent has no tool for an action, it cannot be tricked into using it.'
  },
  {
    id: 'uc2-3',
    deck: 'UC2',
    category: 'Harness Engineering',
    slideRef: 'Demo vs. Production',
    question: 'Why does the exact same LLM often succeed in production with a good "harness" after failing in a simple loop?',
    options: [
      'The harness retrains the model weights every night',
      'The harness adds structure: planning, code-enforced rules, safe retries, and human approvals',
      'The harness removes all safety checks for speed',
      'The harness forces the model to output only 1-word answers'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Your demo works; production needs a harness. Reliable agents pair the LLM with deterministic routing, code guardrails, error handling, and HITL pauses.'
  },
  {
    id: 'uc2-4',
    deck: 'UC2',
    category: 'Prompt Injection',
    slideRef: 'Untrusted Inputs',
    question: 'What is an "indirect prompt injection" attack against an enterprise AI agent?',
    options: [
      'A developer accidentally forgetting to deploy a new prompt version',
      'Malicious instructions hidden inside untrusted data (like emails, tickets, or web pages) the agent reads',
      'An API timeout caused by high network latency',
      'A user typing a very long question in the chat box'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Because LLMs mix instructions and data in the same context window, any external text an agent reads can try to hijack its next tool call.'
  },
  {
    id: 'uc2-5',
    deck: 'UC2',
    category: 'In-Tool Guardrails',
    slideRef: 'Code Rules vs. Prompt Rules',
    question: 'Why should a strict business rule (like "no refunds over $50 without approval") live in tool code instead of only in the system prompt?',
    options: [
      'System prompts cannot contain numbers or currency symbols',
      'Prompt rules can be bypassed by injection or drift; code enforces hard limits every time',
      'Tool code is cheaper per token than prompts',
      'LLMs ignore the last paragraph of every system prompt'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Put non-negotiable rules in code (`ToolContext` / tool guards). Prompts guide tone and reasoning; code enforces hard financial and safety boundaries.'
  },
  {
    id: 'uc2-6',
    deck: 'UC2',
    category: 'Identity & Access',
    slideRef: 'User-Auth vs. Shared Agent-Auth',
    question: 'When an agent fetches a customer\'s private order or address, why use User-Auth instead of a shared admin service account?',
    options: [
      'User-Auth ensures the agent can only access data that specific caller is allowed to see',
      'User-Auth makes database queries 10× faster',
      'Shared service accounts cannot call REST APIs',
      'User-Auth automatically encrypts the LLM weights'
    ],
    correctIndex: 0,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'A shared admin account lets prompt injection leak another user\'s data. User-Auth scopes every tool call to the caller\'s own permissions.'
  },
  {
    id: 'uc2-7',
    deck: 'UC2',
    category: 'ADK Architecture',
    slideRef: 'Callbacks vs. Plugins',
    question: 'In ADK, when should you use a **Plugin** instead of a **Callback** for a guardrail or logging check?',
    options: [
      'Use a Callback for one specific agent; use a Plugin to enforce it across ALL agents in the App',
      'Use a Callback for production; use a Plugin only for local testing',
      'Use a Callback for text; use a Plugin only for images',
      'Callbacks and Plugins are identical with different names'
    ],
    correctIndex: 0,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Callbacks attach to a single agent, while Plugins hook into the whole App lifecycle so security and observability policies never miss a sub-agent.'
  },
  {
    id: 'uc2-8',
    deck: 'UC2',
    category: 'Human-in-the-Loop',
    slideRef: 'Approval Pauses',
    question: 'What is the purpose of a Human-in-the-Loop (HITL) approval step in an enterprise agent?',
    options: [
      'To have humans rewrite every sentence the agent outputs',
      'To pause execution before high-risk actions until a human approves or rejects',
      'To manually restart the server whenever a user disconnects',
      'To replace all automated unit tests'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'HITL (via ADK Tool Confirmation / `RequestInput` or `REQUIRES_ACTION` approval states) lets agents work autonomously on safe steps while pausing for human sign-off on high-impact actions.'
  },
  {
    id: 'uc2-9',
    deck: 'UC2',
    category: 'Agent Evaluation',
    slideRef: 'Why One Demo Isn\'t Enough',
    question: 'Why isn\'t one successful live demo enough to sign off a conversational agent for 10,000 users?',
    options: [
      'Demos run on a different internet protocol',
      'LLMs are non-deterministic—one lucky trial doesn\'t prove consistent reliability across edge cases',
      'Cloud Run disables logging during live demos',
      'Demos only support 1 turn of conversation'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'One demo is one trial. Production sign-off requires repeatable test suites, simulated difficult users, and consistency metrics (like `pass^k`).'
  },
  {
    id: 'uc2-10',
    deck: 'UC2',
    category: 'Trajectory Grading',
    slideRef: 'Grade Actions, Not Just Text',
    question: 'When evaluating a tool-using agent, why should you grade its tool calls and side effects—not just its final text reply?',
    options: [
      'Final text replies are never logged in Cloud Trace',
      'A polite, fluent reply can still hide a wrong tool call, bad argument, or skipped approval',
      'Tool calls are always shorter to read than text',
      'LLM judges cannot read English sentences'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Grade what the agent DID, not just what it SAID: verify tool calls, arguments, and resulting state so silent failures don\'t slip through.'
  },
  {
    id: 'uc2-11',
    deck: 'UC2',
    category: 'Observability',
    slideRef: 'Cloud Trace vs. BigQuery',
    question: 'In production agent observability, what is the difference between **Cloud Trace** and **BigQuery**?',
    options: [
      'Cloud Trace debugs one slow or broken request; BigQuery analyzes trends and cost across thousands of runs',
      'Cloud Trace is for billing only; BigQuery is for live chat UIs',
      'Cloud Trace replaces BigQuery once traffic exceeds 1,000 users',
      'Both tools do the exact same thing with different charts'
    ],
    correctIndex: 0,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Use Cloud Trace waterfalls to inspect a single failing or slow turn, and BigQuery `agent_events` to answer fleet-wide questions on latency, cost, and business ROI.'
  },
  {
    id: 'uc2-12',
    deck: 'UC2',
    category: 'Safety Screening',
    slideRef: 'Model Armor',
    question: 'What is the primary role of **Model Armor** in an enterprise agent architecture?',
    options: [
      'Autoscaling GPU nodes during traffic spikes',
      'Screening prompts and tool responses for prompt injection, sensitive data (PII), and unsafe content',
      'Storing long-term user preferences across chat sessions',
      'Converting Python agents into Go binaries'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Model Armor sits as an independent safety screen across prompts and MCP tool payloads—catching prompt injections and PII leaks before they harm users or systems.'
  },
  {
    id: 'uc2-13',
    deck: 'UC2',
    category: 'Agent FinOps',
    slideRef: 'Cost per Conversation',
    question: 'Why should teams track cost **per conversation** rather than cost **per single message** for AI agents?',
    options: [
      'Cloud Billing only bills once per day',
      'Multi-turn tool loops, retries, and growing chat history multiply cost across a full conversation',
      'Single messages are always free on Vertex AI',
      'BigQuery cannot count individual messages'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'A single cheap-looking message hides multi-step tool calls and re-sent history. Pricing per completed conversation connects AI spend directly to business value.'
  },
  {
    id: 'uc2-14',
    deck: 'UC2',
    category: 'Agent Identity',
    slideRef: 'Delegated vs. Dedicated Identity',
    question: 'What is the key difference between a **Delegated Personal** agent and a **Dedicated CoWorker** agent?',
    options: [
      'Personal agents run on mobile phones; CoWorker agents run only on desktops',
      'Personal agents act as you with your credentials; CoWorker agents have their own dedicated corporate identity, inbox, and calendar',
      'Personal agents can send emails; CoWorker agents can only read spreadsheets',
      'Personal agents are for developers; CoWorker agents are only for external customers'
    ],
    correctIndex: 1,
    timeLimit: 20,
    doublePoints: false,
    explanation: 'Delegated Personal agents act on your behalf under your identity; Dedicated CoWorker agents act as team colleagues with their own corporate service identity and mailbox.'
  },
  {
    id: 'uc2-15',
    deck: 'UC2',
    category: 'Hybrid Architecture',
    slideRef: 'General Agent + Custom ADK',
    question: 'FINAL BOSS (2×): When pairing a general enterprise workspace agent with a custom ADK agent, how should work be split?',
    options: [
      'Delete the custom ADK agent and put all financial rules in a prompt',
      'General agent handles open-ended research & drafts; custom ADK keeps strict transactional actions',
      'Custom ADK does open-ended research; general agent makes unguarded database writes',
      'Run both agents on the exact same task and pick whichever finishes first'
    ],
    correctIndex: 1,
    timeLimit: 25,
    doublePoints: true,
    explanation: 'Best of both worlds: let the general harness handle open-ended analysis, Sheets, and email drafts via read-only tools, while strict transactional actions (like guarded refunds) stay in deterministic ADK workflows.'
  }
];

module.exports = { QUESTIONS };
