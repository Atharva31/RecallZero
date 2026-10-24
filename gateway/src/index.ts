// Agent-facing HTTP gateway (PLAN.md section 9). Contract: shared/contracts/gateway.ts.
// Mode: GATEWAY_MODE=mock (default, in-memory fixtures) | spacetimedb (TODO Sarvesh, Sat morning:
// one SpacetimeDB connection + stored token per org, call reducers as that identity).

import express, { type NextFunction, type Request, type Response } from 'express';

import { ENDPOINTS, ORG_HEADER, type ErrorBody } from '../../shared/contracts/gateway.ts';
import { createMockDb, ReducerError } from './mock.ts';

const PORT = Number(process.env.GATEWAY_PORT ?? 4000);
const MODE = process.env.GATEWAY_MODE ?? 'mock';
if (MODE !== 'mock') console.warn(`GATEWAY_MODE=${MODE} not implemented yet, using mock`);

const db = createMockDb();
const app = express();
app.use(express.json());

type Handler = (req: Request, orgId: string) => object;

/** Wraps a handler: reads X-Org-Id, maps ReducerError to ErrorBody. */
const route = (fn: Handler) => (req: Request, res: Response) => {
  const orgId = req.header(ORG_HEADER) ?? '';
  try {
    res.json({ ok: true, ...fn(req, orgId) });
  } catch (e) {
    if (e instanceof ReducerError) {
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'UNAUTHORIZED' ? 403 : 409;
      const body: ErrorBody = { ok: false, error: { code: e.code, message: e.message.replace(/^[A-Z_]+:\s*/, '') } };
      res.status(status).json(body);
    } else {
      throw e;
    }
  }
};

const p = (req: Request, name: string) => String(req.params[name]);

app.get(ENDPOINTS.health.path, route(() => ({ spacetimedb: 'mock', orgs: db.organizations.map(o => o.id) })));
app.get(ENDPOINTS.getLot.path, route(req => ({ lot: db.getLot(p(req, 'lotId')) })));
app.post(ENDPOINTS.reportRecallSignal.path, route((req, org) => ({ recall: db.reportRecallSignal(org, req.body.rootLotId, req.body.reason) })));
app.post(ENDPOINTS.authorizeRecall.path, route((req, org) => ({ recall: db.authorizeRecall(org, p(req, 'recallId')) })));
app.post(ENDPOINTS.traceRecall.path, route((req, org) => db.traceRecall(org, p(req, 'recallId'))));
app.post(ENDPOINTS.assignContainmentTasks.path, route((req, org) => db.assignContainmentTasks(org, p(req, 'recallId'))));
app.get(ENDPOINTS.getRecallStatus.path, route(req => db.getRecallStatus(p(req, 'recallId'))));
app.get(ENDPOINTS.getReportFacts.path, route(req => ({ facts: db.getReportFacts(p(req, 'recallId')) })));
app.post(ENDPOINTS.closeRecall.path, route((req, org) => ({ recall: db.closeRecall(org, p(req, 'recallId'), req.body.note) })));
app.get(ENDPOINTS.getTask.path, route(req => ({ task: db.getTask(p(req, 'taskId')) })));
app.post(ENDPOINTS.claimTask.path, route((req, org) => ({ task: db.claimTask(org, p(req, 'taskId')) })));
app.post(ENDPOINTS.quarantineLot.path, route((req, org) => db.quarantineLot(org, p(req, 'taskId'))));
app.get(ENDPOINTS.getInventory.path, route(req => ({ locationId: p(req, 'locationId'), balances: db.getInventory(p(req, 'locationId')) })));
app.post(ENDPOINTS.recordSale.path, route((req, org) => ({ balance: db.recordSale(org, req.body.locationId, req.body.lotId, Number(req.body.qty)) })));
app.get(ENDPOINTS.getAudit.path, route(req => ({ events: db.getAudit(req.query.recallId as string | undefined) })));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const body: ErrorBody = { ok: false, error: { code: 'UNKNOWN', message: err.message } };
  res.status(500).json(body);
});

app.listen(PORT, () => console.log(`gateway (${MODE}) listening on http://localhost:${PORT}`));
