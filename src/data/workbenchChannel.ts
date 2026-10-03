import { Workbench } from '../app/Contract';
import type { WorkbenchService } from './WorkbenchService';

/**
 * The service, published as the contract's channel.
 *
 * One observable per view key and one handler per command, and nothing
 * else: this object is the entire seam between the database and the
 * screen. `serveChannels` takes it in the application worker, and the
 * specs hand the same object to `useChannel(..., { source })`.
 */
export function workbenchChannel(service: WorkbenchService) {
  return {
    token: Workbench,
    source: {
      view: {
        run: service.run$,
        result: service.result$,
        window: service.window$,
        schema: service.schema$,
        history: service.history$,
        draft: service.draft$,
        engine: service.engine$,
        chart: service.chart$,
        profile: service.profile$,
        download: service.download$,
        notice: service.notice$,
        cell: service.cell$,
        clipboard: service.clipboard$
      },
      commands: {
        run: (request: { sql: string; at: number }) => void service.run(request),
        cancel: () => void service.cancel(),
        fetch: service.fetch.bind(service),
        sort: (request: Parameters<WorkbenchService['sort']>[0]) => void service.sort(request),
        open: (file: { name: string; bytes: Uint8Array }) => void service.open(file),
        sample: (rows: number) => void service.sample(rows),
        saveDraft: (text: string) => service.saveDraft(text),
        clearHistory: () => service.clearHistory(),
        chart: (request: Parameters<WorkbenchService['chart']>[0]) => void service.chart(request),
        profile: (request: Parameters<WorkbenchService['profile']>[0]) => void service.profile(request),
        exportCsv: (request: { id: number }) => void service.exportCsv(request),
        cell: (request: Parameters<WorkbenchService['cell']>[0]) => void service.cell(request),
        copy: (request: Parameters<WorkbenchService['copy']>[0]) => void service.copy(request)
      }
    }
  };
}
