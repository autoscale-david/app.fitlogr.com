export function flag(value: number | boolean | null): boolean {
  return value === true || value === 1;
}

export function plain<T extends object>(row: T): T {
  return { ...row };
}
