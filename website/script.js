const waveConfigs = [
  { selector: '[data-wave="hero"]', bars: 36, speed: 0.0018, amplitude: 0.65, offset: 0.0 },
  { selector: '[data-wave="app"]', bars: 28, speed: 0.0022, amplitude: 0.58, offset: 0.75 },
];

function buildWave(el, bars) {
  if (!el) return null;
  el.style.setProperty('--bars', bars);
  el.innerHTML = '';
  const nodes = [];
  for (let i = 0; i < bars; i++) {
    const bar = document.createElement('span');
    bar.className = 'wavebar';
    bar.dataset.i = String(i);
    bar.style.setProperty('--scale', '0.35');
    el.appendChild(bar);
    nodes.push(bar);
  }
  return nodes;
}

const waves = waveConfigs.map((cfg) => ({
  ...cfg,
  nodes: buildWave(document.querySelector(cfg.selector), cfg.bars),
})).filter((item) => item.nodes);

function animateWaves(t) {
  for (const wave of waves) {
    const len = wave.nodes.length;
    for (let i = 0; i < len; i++) {
      const node = wave.nodes[i];
      const center = (len - 1) / 2;
      const distance = Math.abs(i - center) / center;
      const waveA = Math.sin(t * wave.speed + i * 0.44 + wave.offset) * 0.5 + 0.5;
      const waveB = Math.cos(t * (wave.speed * 0.72) + i * 0.27 - wave.offset) * 0.5 + 0.5;
      const lift = (1 - distance * 0.72) * wave.amplitude;
      const scale = 0.10 + lift * (0.35 + waveA * 0.55) + waveB * 0.10;
      node.style.setProperty('--scale', scale.toFixed(3));
      node.style.opacity = String(0.38 + scale * 0.45);
    }
  }
  requestAnimationFrame(animateWaves);
}

function setVisibleOnScroll() {
  const items = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.18 });

  items.forEach((item) => io.observe(item));
}

function addHoverLift() {
  document.querySelectorAll('.feature-card, .stat-card, .mock-window, .app-shell, .callout').forEach((card) => {
    card.addEventListener('mousemove', (event) => {
      const rect = card.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width - 0.5) * 8;
      const y = ((event.clientY - rect.top) / rect.height - 0.5) * 8;
      card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
}

setVisibleOnScroll();
addHoverLift();
requestAnimationFrame(animateWaves);
