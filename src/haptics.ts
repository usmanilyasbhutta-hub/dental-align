// Haptic feedback.
// iOS Safari does not implement navigator.vibrate. Since iOS 18, toggling an
// <input type="checkbox" switch> produces a system haptic tick; we use that, and
// fall back to navigator.vibrate on platforms that support it.

let label: HTMLLabelElement | null = null;

function ensure() {
  if (label) return label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.id = 'da-haptic-switch';
  input.style.cssText = 'position:fixed;left:-100px;top:-100px;opacity:0;pointer-events:none;';
  label = document.createElement('label');
  label.htmlFor = input.id;
  label.style.cssText = 'position:fixed;left:-100px;top:-100px;opacity:0;pointer-events:none;';
  document.body.appendChild(input);
  document.body.appendChild(label);
  return label;
}

export function haptic(pattern: 'tick' | 'success' = 'tick') {
  try {
    if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern === 'success' ? [12, 60, 18] : 10);
      return;
    }
    const l = ensure();
    l.click();
    if (pattern === 'success') setTimeout(() => l.click(), 90);
  } catch {
    /* no haptics available */
  }
}
