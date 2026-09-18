import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function scriptPath(): string {
  // dist/main/wallpaper.js -> ../../scripts/wallpaper.ps1
  return path.join(__dirname, '..', '..', 'scripts', 'wallpaper.ps1');
}

async function runPs(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), ...args],
    { windowsHide: true }
  );
  // The script uses $ErrorActionPreference='Stop', so a real failure throws and
  // execFile rejects. Anything on stderr that still got here is worth surfacing.
  if (stderr.trim()) throw new Error(`wallpaper.ps1: ${stderr.trim()}`);
  return stdout;
}

export interface MonitorRow {
  index: number;
  width: number;
  height: number;
  left: number;
  top: number;
  primary: boolean;
  /** Image currently shown on this monitor, per the shell. */
  image: string;
}

interface RawMonitor {
  Index: number; Width: number; Height: number;
  Left: number; Top: number; Primary: boolean; Image: string;
}

export async function listMonitors(): Promise<MonitorRow[]> {
  const out = (await runPs(['-Action', 'list'])).trim();
  if (!out) throw new Error('wallpaper.ps1 list returned nothing');

  let raw: RawMonitor[];
  try {
    raw = JSON.parse(out) as RawMonitor[];
  } catch (e) {
    throw new Error(`could not parse monitor JSON: ${(e as Error).message}
${out}`);
  }

  const rows = raw.map((m) => ({
    index: m.Index, width: m.Width, height: m.Height,
    left: m.Left, top: m.Top, primary: m.Primary, image: m.Image,
  }));
  if (rows.length === 0) throw new Error('no monitors reported by the shell');
  return rows;
}

/** Set the desktop wallpaper. Primary-only by default so other screens keep theirs. */
export async function setWallpaper(imagePath: string, primaryOnly = true): Promise<string> {
  const args = ['-Action', 'set', '-Path', imagePath, '-Position', 'Fill'];
  if (primaryOnly) args.push('-PrimaryOnly');
  return runPs(args);
}

/**
 * The image currently on the primary monitor, straight from IDesktopWallpaper.
 * Deliberately not read from the registry: the registry holds one global value
 * and goes stale as soon as per-monitor wallpapers are in play.
 */
export async function currentWallpaper(): Promise<string | null> {
  const primary = (await listMonitors()).find((m) => m.primary);
  const img = primary?.image?.trim();
  return img ? img : null;
}
