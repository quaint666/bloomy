// Bloomy — typed DOM helpers for the browser scripts in web/.

// The element with this id. Throws at once, with the id in the message, when the page has no such element
// (or it is not the type asked for), instead of failing later on a null.
export function byId(id: string): HTMLElement;
export function byId<T extends HTMLElement>(id: string, type: new () => T): T;
export function byId<T extends HTMLElement>(id: string, type?: new () => T): HTMLElement | T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  if (type && !(node instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
  return node;
}

// A new element with an optional class and text. The text goes in with textContent, never as markup.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// The first element inside `root` that matches the selector. Throws at once, with the selector in the message, when
// there is none, instead of failing later on a null.
export function qs<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}
