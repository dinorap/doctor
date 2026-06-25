import { useState, useEffect, useCallback } from 'react';

export function usePersistedState<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        return JSON.parse(stored) as T;
      }
    } catch (e) {
      console.warn(`Failed to parse localStorage key "${key}":`, e);
    }
    return defaultValue;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {
      console.warn(`Failed to save localStorage key "${key}":`, e);
    }
  }, [key, state]);

  return [state, setState];
}

export function usePersistedArray<T>(key: string): [T[], {
  add: (item: T) => void;
  remove: (predicate: (item: T, index: number) => boolean) => void;
  update: (predicate: (item: T, index: number) => boolean, updates: Partial<T> | ((item: T) => T)) => void;
  clear: () => void;
  set: (items: T[]) => void;
}] {
  const [items, setItems] = useState<T[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        return JSON.parse(stored) as T[];
      }
    } catch (e) {
      console.warn(`Failed to parse localStorage key "${key}":`, e);
    }
    return [];
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(items));
    } catch (e) {
      console.warn(`Failed to save localStorage key "${key}":`, e);
    }
  }, [key, items]);

  const add = useCallback((item: T) => {
    setItems(prev => [...prev, item]);
  }, []);

  const remove = useCallback((predicate: (item: T, index: number) => boolean) => {
    setItems(prev => prev.filter((item, index) => !predicate(item, index)));
  }, []);

  const update = useCallback((predicate: (item: T, index: number) => boolean, updates: Partial<T> | ((item: T) => T)) => {
    setItems(prev => prev.map((item, index) => {
      if (predicate(item, index)) {
        return typeof updates === 'function' ? updates(item) : { ...item, ...updates };
      }
      return item;
    }));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
  }, []);

  return [items, { add, remove, update, clear, set: setItems }];
}

export function clearPersistedData(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.warn(`Failed to clear localStorage key "${key}":`, e);
  }
}
