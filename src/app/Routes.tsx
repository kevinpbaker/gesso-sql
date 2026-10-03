import { map } from 'rxjs';

import { darkTheme, lightTheme, percent } from 'gesso-core';
import { createComponent, route, RouterOutlet, ShellService, type ComponentContext, type Inputs } from 'gesso-framework';

import { PROOF_PATH } from '../route';
import { WorkbenchApp } from './WorkbenchApp';

/**
 * The two pages, declared in the render worker because a route names a
 * component and a component cannot cross a `postMessage`. Both are the
 * same workbench: `/proof` is this screen with the shell's instrument
 * strip above it, and the strip is the shell's business, not this
 * thread's.
 */
export function WorkbenchScreen(_inputs: Inputs<{}>, _ctx: ComponentContext) {
  return <WorkbenchApp />;
}

export const WORKBENCH = route({ path: '/', component: WorkbenchScreen });
export const PROOF = route({ path: PROOF_PATH, component: WorkbenchScreen });
export const ROUTES = [WORKBENCH, PROOF];

/**
 * The root: an outlet in a box, since an outlet cannot be the layout
 * root itself, and the theme the system asks for.
 *
 * A canvas inherits no appearance from the page, so light and dark are
 * chosen here from what the shell reports, and follow it when it
 * changes. Every colour below is a theme token or a mid-tone picked to
 * read on both, so this one prop is the whole of dark mode.
 */
export function AppRoot(_inputs: Inputs<{}>, ctx: ComponentContext) {
  const shell = ctx.inject(ShellService);
  const theme = shell.colorScheme.pipe(map(scheme => (scheme === 'dark' ? darkTheme : lightTheme)));
  return (
    <column
      width={percent(100)}
      height={percent(100)}
      theme={theme}
      // With the theme, its body style: text that names no colour takes
      // it from the type scale in the environment, not from the theme, so
      // a root that provided only the theme left such text black in the
      // dark theme too.
      textStyle={theme.pipe(map(value => value.typography.body))}
      backgroundColor="background">
      {createComponent(RouterOutlet)}
    </column>
  );
}
