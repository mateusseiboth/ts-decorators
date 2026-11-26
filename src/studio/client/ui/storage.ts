/**
 * Persistência local do Studio. O `localStorage` pode estar cheio, bloqueado ou indisponível (aba
 * anônima): toda leitura e escrita é protegida e o editor segue funcionando sem ele.
 */
const PREFIX = "studio.";
const MAX_VERSIONS = 40;

export function readItem(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(PREFIX + key, value);
    return true;
  } catch {
    return false;
  }
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = readItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const writeJson = (key: string, value: unknown) => writeItem(key, JSON.stringify(value));

export interface Version {
  id: string;
  at: number;
  name: string;
  reason: string;
  content: string;
}

export const listVersions = () => readJson<Version[]>("versions", []);

/** Guarda uma versão, sem repetir a última quando o conteúdo é o mesmo. */
export function saveVersion(name: string, content: string, reason: string): boolean {
  const versions = listVersions();
  if (!content.trim() || versions[0]?.content === content) return false;
  const version: Version = { id: crypto.randomUUID(), at: Date.now(), name, reason, content };
  return writeJson("versions", [version, ...versions].slice(0, MAX_VERSIONS));
}

export function removeVersion(id: string): void {
  writeJson(
    "versions",
    listVersions().filter((version) => version.id !== id),
  );
}
