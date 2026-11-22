// Procedural Web Audio API Music & SFX Studio Engine (zero external MP3 dependencies)
class QuizAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.muted = false;
    this.volume = 0.45;
    this.currentTrack = null; // 'lobby' | 'question' | null
    this.loopTimer = null;
    this.step = 0;
    this.urgent = false;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, Number(val)));
    if (this.masterGain && this.ctx && !this.muted) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
    }
  }

  tone(freq, duration, type = 'triangle', gainVal = 0.25, delay = 0, slideTo = null) {
    const ctx = this.ensureContext();
    if (!ctx || this.muted) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
    }
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gainVal), now + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  hat(delay = 0, gainVal = 0.05) {
    const ctx = this.ensureContext();
    if (!ctx || this.muted) return;
    const now = ctx.currentTime + delay;
    const bufferSize = ctx.sampleRate * 0.035;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6500;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);

    noise.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    noise.start(now);
  }

  kick(delay = 0, gainVal = 0.28) {
    this.tone(135, 0.14, 'sine', gainVal, delay, 42);
  }

  stopMusic() {
    this.currentTrack = null;
    this.urgent = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  setUrgent(flag) {
    this.urgent = Boolean(flag);
  }

  startLobbyMusic() {
    if (this.currentTrack === 'lobby') return;
    this.stopMusic();
    this.currentTrack = 'lobby';
    this.step = 0;

    // Bouncy, upbeat Kahoot-style marimba lobby groove (C major / A minor)
    const melody = [523.25, 0, 659.25, 587.33, 523.25, 0, 783.99, 659.25, 440.0, 0, 523.25, 587.33, 659.25, 0, 587.33, 0];
    const bass = [130.81, 0, 130.81, 0, 164.81, 0, 196.0, 0, 110.0, 0, 110.0, 0, 146.83, 0, 196.0, 0];

    const tick = () => {
      if (this.currentTrack !== 'lobby') return;
      const i = this.step % melody.length;
      if (melody[i]) this.tone(melody[i], 0.16, 'triangle', 0.16);
      if (bass[i]) this.tone(bass[i], 0.22, 'sine', 0.22);
      if (i % 4 === 0) this.kick(0, 0.2);
      if (i % 2 === 1) this.hat(0, 0.035);
      this.step++;
      this.loopTimer = setTimeout(tick, 240);
    };
    tick();
  }

  startQuestionMusic() {
    if (this.currentTrack === 'question') return;
    this.stopMusic();
    this.currentTrack = 'question';
    this.step = 0;
    this.urgent = false;

    // Energetic quiz-show pulse with rising tension
    const riff = [261.63, 329.63, 392.0, 329.63, 293.66, 349.23, 440.0, 349.23, 329.63, 392.0, 493.88, 392.0, 349.23, 440.0, 523.25, 440.0];
    const bass = [130.81, 0, 130.81, 0, 146.83, 0, 146.83, 0, 164.81, 0, 164.81, 0, 174.61, 0, 196.0, 0];

    const tick = () => {
      if (this.currentTrack !== 'question') return;
      const i = this.step % riff.length;
      const shift = this.urgent ? 1.122 : 1.0; // +2 semitones when urgent!
      const interval = this.urgent ? 155 : 210; // speeds up in final 5 seconds!

      this.tone(riff[i] * shift, 0.14, 'square', this.urgent ? 0.1 : 0.07);
      this.tone(riff[i] * 2 * shift, 0.1, 'triangle', 0.09);
      if (bass[i]) this.tone(bass[i] * shift, 0.18, 'sawtooth', 0.1);
      if (i % 2 === 0) this.kick(0, this.urgent ? 0.28 : 0.22);
      this.hat(0, this.urgent ? 0.06 : 0.04);

      this.step++;
      this.loopTimer = setTimeout(tick, interval);
    };
    tick();
  }

  playJoin() {
    this.tone(587.33, 0.09, 'sine', 0.16, 0);
    this.tone(880.0, 0.13, 'triangle', 0.18, 0.06);
  }

  playCountdownTick(isGo = false) {
    if (isGo) {
      this.tone(523.25, 0.22, 'triangle', 0.26, 0);
      this.tone(659.25, 0.22, 'triangle', 0.26, 0.05);
      this.tone(1046.5, 0.35, 'triangle', 0.28, 0.1);
    } else {
      this.tone(440, 0.11, 'sine', 0.22, 0);
    }
  }

  playAnswerClick() {
    this.tone(720, 0.07, 'triangle', 0.2, 0, 960);
  }

  playRevealCorrect() {
    this.tone(523.25, 0.16, 'triangle', 0.24, 0);
    this.tone(659.25, 0.16, 'triangle', 0.24, 0.09);
    this.tone(783.99, 0.18, 'triangle', 0.24, 0.18);
    this.tone(1046.5, 0.42, 'triangle', 0.28, 0.27);
  }

  playRevealWrong() {
    this.tone(311.13, 0.2, 'sawtooth', 0.14, 0, 260);
    this.tone(233.08, 0.32, 'sawtooth', 0.14, 0.18, 195);
  }

  playLeaderboard() {
    const notes = [392.0, 493.88, 587.33, 783.99];
    notes.forEach((n, idx) => this.tone(n, 0.22, 'triangle', 0.2, idx * 0.07));
  }

  partyPopper(delay = 0) {
    const ctx = this.ensureContext();
    if (!ctx || this.muted) return;
    const now = ctx.currentTime + delay;

    // 1. Crisp acoustic pop crack (bandpass-filtered noise burst)
    const popDur = 0.085;
    const bufferSize = Math.floor(ctx.sampleRate * popDur);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.22));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1900, now);
    filter.Q.value = 0.9;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.65, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + popDur);

    noise.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    noise.start(now);

    // 2. Snappy air-cannon thump
    this.tone(240, 0.09, 'sine', 0.35, delay, 65);

    // 3. Confetti flutter sparkles
    const sparkles = [1318.5, 1567.98, 2093.0, 2637.0];
    sparkles.forEach((f, idx) => {
      this.tone(f, 0.14, 'triangle', 0.11, delay + 0.06 + idx * 0.045);
    });
  }

  playPodiumFanfare() {
    this.stopMusic();
    // Multi-burst party poppers cannons!
    this.partyPopper(0.0);
    this.partyPopper(0.18);
    this.partyPopper(0.36);
    this.partyPopper(0.72);

    // Celebratory victory fanfare layered on top
    const seq = [
      [523.25, 0.12, 0.16],
      [659.25, 0.26, 0.16],
      [783.99, 0.40, 0.16],
      [1046.5, 0.56, 0.48],
      [783.99, 0.80, 0.16],
      [1046.5, 0.96, 0.85]
    ];
    for (const [f, d, dur] of seq) {
      this.tone(f, dur, 'triangle', 0.25, d);
      this.tone(f * 0.5, dur, 'sine', 0.16, d);
    }
  }
}

window.quizAudio = new QuizAudioEngine();
