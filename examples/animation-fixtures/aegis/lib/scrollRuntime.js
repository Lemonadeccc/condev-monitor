"use client";

import { useSyncExternalStore } from "react";

let offset = 0;
let scrollElement = null;
const listeners = new Set();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function updateScrollRuntime(nextOffset, nextElement) {
  const normalized = Math.min(1, Math.max(0, nextOffset));
  const offsetChanged = Math.abs(normalized - offset) > 0.00025;
  const elementChanged = nextElement !== scrollElement;

  offset = normalized;
  scrollElement = nextElement ?? scrollElement;

  if (offsetChanged || elementChanged) {
    emit();
  }
}

export function getScrollOffset() {
  return offset;
}

export function subscribeToScroll(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useScrollOffset() {
  return useSyncExternalStore(
    subscribeToScroll,
    getScrollOffset,
    () => 0
  );
}

export function scrollToProgress(progress, behavior = "smooth") {
  if (!scrollElement) {
    return;
  }

  const maxScroll = scrollElement.scrollHeight - scrollElement.clientHeight;

  scrollElement.scrollTo({
    top: Math.min(1, Math.max(0, progress)) * maxScroll,
    behavior,
  });
}
