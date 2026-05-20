export class TtlCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>();

  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}
