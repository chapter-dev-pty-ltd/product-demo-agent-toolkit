// TEMPORARY: effects that show what the stage can do, put on with `cut --showcase`. Each is
// plain HTML and CSS, timed with data-at and data-for; nothing here is drawn frame by frame.

export const SHOWCASE = `<style>
#title {
  position: absolute; left: 240px; top: 24px; padding: 12px 20px 12px 16px;
  display: flex; gap: 12px; align-items: center; border-radius: 999px;
  background: rgb(255 255 255 / .9); color: #111; font-size: 22px; font-weight: 600;
  box-shadow: 0 8px 30px rgb(0 0 0 / .18); animation: title 3.4s both;
}
#title b { width: 30px; height: 30px; border-radius: 50%; background: #111; color: #fff;
  display: grid; place-items: center; font-size: 15px; }
@keyframes title {
  0% { transform: translateY(-80px); opacity: 0; }
  12%, 85% { transform: none; opacity: 1; }
  100% { transform: translateY(-10px); opacity: 0; }
}
.ring { position: absolute; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
  border: 3px solid #ff7ccb; animation: ring .5s cubic-bezier(.2,.7,.3,1) both; }
@keyframes ring { from { transform: scale(.2); opacity: .9; } to { transform: scale(1.4); opacity: 0; } }
#badge { position: absolute; right: 270px; bottom: 112px; padding: 10px 16px; border-radius: 12px;
  background: #111; color: #fff; font: 700 24px/1 ui-monospace, Menlo, monospace;
  display: flex; gap: 10px; align-items: center; animation: badge 5s both; }
#badge i { width: 10px; height: 10px; border-radius: 50%; background: #b6f24f; animation: blink .6s infinite alternate; }
@keyframes badge { 0% { transform: scale(.4) rotate(-8deg); opacity: 0; } 8%, 92% { transform: none; opacity: 1; } 100% { transform: scale(.8); opacity: 0; } }
@keyframes blink { to { opacity: .2; } }
#camera.push { animation: push 6s cubic-bezier(.65,0,.35,1) both; }
@keyframes push { 0% { transform: scale(1); } 30%, 100% { transform: scale(1.45); } }
.bit { position: absolute; width: 10px; height: 16px; border-radius: 2px; animation: burst 2s both; }
@keyframes burst {
  0% { transform: translate(0, 0) rotate(0); opacity: 1; }
  35% { transform: translate(calc(var(--dx) * .8), var(--up)) rotate(calc(var(--r) * .5)); animation-timing-function: ease-in; }
  100% { transform: translate(var(--dx), 420px) rotate(var(--r)); opacity: 0; }
}
</style>
<script>
(() => {
  const { length, clicks, pointer, title } = stage.data;
  const camera = document.getElementById('camera');
  const add = (parent, html, at, span) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    const node = el.firstElementChild;
    node.dataset.at = at;
    if (span) node.dataset.for = span;
    parent.append(node);
    return node;
  };
  // A title that drops in at the start.
  add(document.body, '<div id="title"><b>▶</b>' + (title || 'Product demo') + '</div>', 0.3, 3.4);
  // A ring from the cursor's tip on every click.
  for (const c of clicks) add(camera, '<div class="ring" style="left:' + c.x + 'px;top:' + c.y + 'px"></div>', c.at, 0.5);
  // A speed badge for a stretch in the middle.
  add(document.body, '<div id="badge"><i></i>2× speed</div>', length * 0.35, 5);
  // The camera pushes in on where the pointer ends, for the last six seconds.
  const end = pointer[pointer.length - 1] || { x: 720, y: 450 };
  camera.style.transformOrigin = end.x + 'px ' + end.y + 'px';
  camera.classList.add('push');
  camera.dataset.at = Math.max(0, length - 6);
  // Confetti from the same spot as it lands.
  const colours = ['#ff7ccb', '#b6f24f', '#ffd84a', '#7cc8ff', '#ff8a3d'];
  for (let i = 0; i < 48; i++) {
    const angle = (i / 48) * Math.PI * 2, power = 120 + ((i * 37) % 160);
    const style = 'left:' + end.x + 'px;top:' + end.y + 'px;background:' + colours[i % 5] +
      ';--dx:' + Math.round(Math.cos(angle) * power) + 'px;--up:' + Math.round(-140 - Math.abs(Math.sin(angle)) * power) +
      'px;--r:' + ((i * 97) % 720 - 360) + 'deg';
    add(camera, '<div class="bit" style="' + style + '"></div>', Math.max(0, length - 3.5), 2);
  }
})();
</script>`
