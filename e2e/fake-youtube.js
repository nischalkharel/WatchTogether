// Stand-in for https://www.youtube.com/iframe_api used by the e2e tests.
// Same API surface the app uses; time advances with the real clock. It also
// mimics browsers that refuse to autoplay with sound until the user taps.
(function () {
  const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  const cfg = (window.__fakeYT = window.__fakeYT || {});
  cfg.duration = cfg.duration || 600;
  cfg.players = [];

  function Player(el, opts) {
    const box = typeof el === 'string' ? document.getElementById(el) : el;
    const frame = document.createElement('div');
    frame.id = box.id;
    frame.className = 'fake-yt';
    frame.style.cssText = 'position:absolute;inset:0;background:#222;color:#fff;display:grid;place-items:center;font:14px monospace';
    box.replaceWith(frame);
    this.el = frame;
    this.ev = opts.events || {};
    this.vars = opts.playerVars || {};
    this.st = S.UNSTARTED;
    this.t = 0;
    this.base = performance.now();
    this.vid = null;
    this.muted = false;
    this.userGesture = !cfg.blockUnmutedAutoplay;
    this.log = [];
    cfg.players.push(this);
    frame.addEventListener('pointerdown', () => (this.userGesture = true));
    setTimeout(() => this.ev.onReady && this.ev.onReady({ target: this }), 50);
    setInterval(() => this.render(), 200);
  }
  const P = Player.prototype;
  P.adv = function () {
    const now = performance.now();
    if (this.st === S.PLAYING) {
      this.t += (now - this.base) / 1000;
      if (this.t >= cfg.duration) {
        this.t = cfg.duration;
        this.base = now;
        this.set(S.ENDED);
      }
    }
    this.base = now;
  };
  P.set = function (st) {
    this.adv();
    if (this.st === st) return;
    this.st = st;
    this.log.push(st);
    const cb = this.ev.onStateChange;
    setTimeout(() => cb && cb({ data: st, target: this }), 0);
  };
  P.render = function () {
    this.adv();
    this.el.textContent = `${this.vid || '-'} ${this.st} ${this.t.toFixed(1)}${this.muted ? ' muted' : ''}`;
  };
  P.canPlay = function () {
    return this.userGesture || this.muted;
  };
  P.startPlaying = function () {
    if (!this.canPlay()) {
      this.set(S.PAUSED); // browser blocked it
      return;
    }
    this.set(S.BUFFERING);
    setTimeout(() => this.st === S.BUFFERING && this.set(S.PLAYING), cfg.bufferMs || 150);
  };
  P.loadVideoById = function (o) {
    this.vid = o.videoId;
    this.t = o.startSeconds || 0;
    this.st = S.UNSTARTED;
    this.startPlaying();
  };
  P.cueVideoById = function (o) {
    this.vid = o.videoId;
    this.t = o.startSeconds || 0;
    this.set(S.CUED);
  };
  P.playVideo = function () {
    if (this.st === S.PLAYING || this.st === S.BUFFERING) return;
    this.startPlaying();
  };
  P.pauseVideo = function () {
    if (this.st === S.PLAYING || this.st === S.BUFFERING) this.set(S.PAUSED);
  };
  P.seekTo = function (t) {
    this.adv();
    this.t = Math.max(0, Math.min(cfg.duration, t));
    if (this.st === S.PLAYING) {
      this.set(S.BUFFERING);
      setTimeout(() => this.st === S.BUFFERING && this.set(S.PLAYING), cfg.bufferMs || 150);
    }
  };
  P.getPlayerState = function () { this.adv(); return this.st; };
  P.getCurrentTime = function () { this.adv(); return this.t; };
  P.getDuration = function () { return this.vid && this.st !== S.UNSTARTED ? cfg.duration : 0; };
  P.getVideoData = function () { return { title: this.vid ? `Test video ${this.vid}` : '' }; };
  P.mute = function () { this.muted = true; };
  P.unMute = function () { this.muted = false; this.userGesture = true; };
  P.isMuted = function () { return this.muted; };

  // Helpers for tests to simulate a person using YouTube's own controls.
  P.userPause = function () { this.userGesture = true; this.pauseVideo(); };
  P.userPlay = function () { this.userGesture = true; this.playVideo(); };
  P.userScrub = function (t) {
    this.userGesture = true;
    const was = this.st;
    this.adv();
    if (was === S.PLAYING) this.set(S.PAUSED);
    this.t = t;
    if (was === S.PLAYING) {
      setTimeout(() => this.set(S.BUFFERING), 30);
      setTimeout(() => this.set(S.PLAYING), 200);
    }
  };
  P.stall = function (ms) {
    this.set(S.BUFFERING);
    setTimeout(() => this.set(S.PLAYING), ms);
  };

  window.YT = { Player, PlayerState: S };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
})();
