/**
 * Which page is being asked for, for the one thread that cannot ask
 * the router.
 *
 * `/` is the workbench. `/proof` is the same workbench with the
 * instruments attached: the strip along the top that times the main
 * thread and the render worker, the button that blocks the main thread,
 * and the layout heatmap. The strip is DOM on the main thread, which is
 * the entire reason it is believable, so the shell has to answer this
 * question for itself from `location`. Kept as small as a module can be,
 * because it is reachable from both threads.
 */
export const PROOF_PATH = '/proof';

export function isProofPath(pathname: string): boolean {
  return segments(pathname).join('/') === segments(PROOF_PATH).join('/');
}

function segments(path: string): string[] {
  return path.split('/').filter(segment => segment.length > 0);
}
