import { useEffect, useRef } from 'preact/hooks';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const modalStack = [];
let modalOverflow = null;

function isFocusableElement(element) {
  if (element.hidden || element.closest('[inert]')) return false;
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

export function useModalFocus({ open = true, containerRef, onClose, initialFocusRef = null, returnFocusRef = null }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const container = containerRef.current;
    if (!open || !container) return undefined;
    modalStack.push(container);
    if (modalStack.length === 1) {
      modalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    const previouslyFocused = document.activeElement;
    const inerted = [];
    let node = container;
    for (let ancestor = container.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
      for (const sibling of ancestor.children) {
        if (sibling !== node && !sibling.contains(container) && !sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '');
          inerted.push(sibling);
        }
      }
      node = ancestor;
    }
    const focusTargets = () => [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(isFocusableElement);
    (initialFocusRef?.current && isFocusableElement(initialFocusRef.current) ? initialFocusRef.current : focusTargets()[0])?.focus();

    const handleKeyDown = (event) => {
      if (modalStack.at(-1) !== container) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusTargets();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      const outside = !container.contains(document.activeElement);
      if (event.shiftKey ? document.activeElement === first || outside : document.activeElement === last || outside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      const stackIndex = modalStack.indexOf(container);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      if (!modalStack.length && modalOverflow !== null) {
        document.body.style.overflow = modalOverflow;
        modalOverflow = null;
      }
      document.removeEventListener('keydown', handleKeyDown, true);
      for (const sibling of inerted) sibling.removeAttribute('inert');
      const restoreTarget = returnFocusRef?.current ?? previouslyFocused;
      if (restoreTarget instanceof HTMLElement && restoreTarget.isConnected) restoreTarget.focus();
    };
  }, [open]);
}
