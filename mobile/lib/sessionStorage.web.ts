const memory = new Map<string, string>();

function store() {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export const sessionStorage = {
  async getItem(key: string) {
    return store()?.getItem(key) ?? memory.get(key) ?? null;
  },
  async setItem(key: string, value: string) {
    memory.set(key, value);
    store()?.setItem(key, value);
  },
  async removeItem(key: string) {
    memory.delete(key);
    store()?.removeItem(key);
  },
};
