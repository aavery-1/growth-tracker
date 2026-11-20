/* Causeway tab icon (Nov 20 2026). Browsers don't animate tab icons, so on page load this redraws the icon
   about 15 times a second for 2.4 seconds: the water flows under the arches, slows and settles, matching the
   header mark. Then the static icon stays. Skipped when the device asks for reduced motion. */
(function () {
  try {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var link = document.querySelector('link[rel="icon"]'); if (!link || !window.Path2D) return;
    var still = link.href, N = 64, cv = document.createElement('canvas'); cv.width = cv.height = N;
    var x = cv.getContext('2d'); if (!x || !cv.toDataURL) return;
    var deck = new Path2D('M3 10.5H29V20H27.5A3.333 3.333 0 0 0 20.833 20H19.333A3.333 3.333 0 0 0 12.667 20H11.167A3.333 3.333 0 0 0 4.5 20H3Z');
    var seg = 'c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0', w = 'M-19.2 3'; for (var i = 0; i < 7; i++) w += ' ' + seg;
    var wave = new Path2D(w);
    var ease = function (t) { var p = 1 - t; return 1 - p * p * p; };   // decelerate, like Carbon's entrance easing
    var draw = function (off) {
      x.setTransform(N / 32, 0, 0, N / 32, 0, 0); x.clearRect(0, 0, 32, 32);
      x.fillStyle = '#001d6c'; x.beginPath(); x.arc(16, 16, 16, 0, Math.PI * 2); x.fill();
      x.save(); x.translate(6.5, 8.5); x.scale(.73, .73); x.translate(-3, -10.5); x.fillStyle = '#fff'; x.fill(deck); x.restore();
      x.fillStyle = '#001d6c'; x.fillRect(6.5, 9.96, 19, .66);
      x.save(); x.beginPath(); x.rect(5, 18.4, 22, 6); x.clip(); x.translate(5 + off, 18.4);
      x.strokeStyle = '#72c1ea'; x.lineWidth = 1.5; x.lineCap = 'round'; x.stroke(wave); x.restore();
      link.href = cv.toDataURL('image/png');
    };
    // A timer, not animation frames: background tabs pause frames, and the icon must still finish and settle there.
    var t0 = Date.now(), D = 2400;
    var iv = setInterval(function () {
      var t = Math.min(1, (Date.now() - t0) / D);
      if (t < 1) draw(-19.2 * (1 - ease(t))); else { clearInterval(iv); link.href = still; }
    }, 66);
  } catch (e) { /* the static icon stays */ }
})();
