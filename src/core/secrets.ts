export class Secrets {
  private values = new Set<string>();
  add(value: string) {
    if (value) {
      this.values.add(value);
      this.values.add(JSON.stringify(value).slice(1, -1));
    }
  }
  redact<T>(input: T): T {
    const values = [...this.values].sort((a, b) => b.length - a.length);
    const clean = (v: unknown): unknown => {
      if (typeof v === 'string') {
        for (const value of values) v = (v as string).split(value).join('[REDACTED]');
        return v;
      }
      if (Array.isArray(v)) return v.map(clean);
      if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
      return v;
    };
    return clean(input) as T;
  }
}
