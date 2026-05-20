import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Database,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  Target,
  Zap
} from "lucide-react";
import type {
  BasePlanWriteResult,
  BuildCandidate,
  BuildPlanResponse,
  Objective,
  WishlistWriteResult
} from "../shared/schemas";
import { buildBuildPlan } from "../shared/planner";
import { getStaticSnapshot, writeStaticBasePlan, writeStaticWishlist } from "./staticGtClient";

type ApiError = {
  error: string;
  details?: unknown;
};

type WriteMessage = {
  kind: "wishlist" | "base-plan";
  text: string;
  tone: "ok" | "warn" | "error";
};

const objectiveOptions: { value: Objective; label: string }[] = [
  { value: "infer", label: "Infer" },
  { value: "profit_per_hour", label: "Profit" },
  { value: "production_uptime", label: "Uptime" },
  { value: "cv_growth", label: "CV Growth" }
];

const isStaticPagesMode = import.meta.env.VITE_STATIC_PAGES === "true";

export function App() {
  const [gtApiKey, setGtApiKey] = useState("");
  const [objective, setObjective] = useState<Objective>("infer");
  const [horizonHours, setHorizonHours] = useState(24);
  const [cashReservePct, setCashReservePct] = useState(25);
  const [maxSpendPct, setMaxSpendPct] = useState(75);
  const [authenticated, setAuthenticated] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [plan, setPlan] = useState<BuildPlanResponse | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [writeMessage, setWriteMessage] = useState<WriteMessage | undefined>();
  const [confirmWishlist, setConfirmWishlist] = useState(false);
  const [confirmBasePlan, setConfirmBasePlan] = useState(false);

  const selectedCandidate = useMemo(() => {
    if (!plan) return undefined;
    return plan.candidates.find((candidate) => candidate.id === selectedId) ?? plan.selectedCandidate;
  }, [plan, selectedId]);

  async function saveSession() {
    setLoadingSession(true);
    setError("");
    try {
      if (isStaticPagesMode) {
        setAuthenticated(gtApiKey.trim().length >= 8);
        return;
      }
      const response = await fetch("/api/session/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gtApiKey })
      });
      if (!response.ok) throw await readApiError(response);
      setAuthenticated(true);
    } catch (caught) {
      setAuthenticated(false);
      setError(errorText(caught));
    } finally {
      setLoadingSession(false);
    }
  }

  async function generatePlan() {
    setLoadingPlan(true);
    setError("");
    setWriteMessage(undefined);
    try {
      if (isStaticPagesMode) {
        if (gtApiKey.trim().length < 8) throw new Error("Enter a Galactic Tycoons API key.");
        setAuthenticated(true);
        const snapshot = await getStaticSnapshot(gtApiKey.trim());
        const nextPlan = buildBuildPlan(snapshot, { objective, horizonHours, cashReservePct, maxSpendPct });
        setPlan(nextPlan);
        setSelectedId(nextPlan.selectedCandidate.id);
        return;
      }
      if (!authenticated) await saveSession();
      const response = await fetch("/api/agent/build-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective, horizonHours, cashReservePct, maxSpendPct })
      });
      if (!response.ok) throw await readApiError(response);
      const nextPlan = (await response.json()) as BuildPlanResponse;
      setPlan(nextPlan);
      setSelectedId(nextPlan.selectedCandidate.id);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoadingPlan(false);
    }
  }

  async function writeWishlist(confirmed: boolean) {
    if (!selectedCandidate?.wishlistManifest) return;
    setWriteMessage(undefined);
    try {
      if (isStaticPagesMode) {
        if (!confirmed) {
          setWriteMessage({
            kind: "wishlist",
            text: "Wishlist write needs explicit confirmation. Review the manifest, then confirm to send it to Galactic Tycoons.",
            tone: "warn"
          });
          return;
        }
        const result = await writeStaticWishlist(gtApiKey.trim(), selectedCandidate.wishlistManifest);
        setWriteMessage({
          kind: "wishlist",
          text: result.message,
          tone: result.status === "manual_only" ? "warn" : "ok"
        });
        return;
      }
      const response = await fetch("/api/agent/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: selectedCandidate.wishlistManifest, confirmed })
      });
      if (!response.ok) throw await readApiError(response);
      const result = (await response.json()) as WishlistWriteResult;
      setWriteMessage({
        kind: "wishlist",
        text: result.message,
        tone: result.status === "manual_only" ? "warn" : "ok"
      });
    } catch (caught) {
      setWriteMessage({ kind: "wishlist", text: errorText(caught), tone: "error" });
    }
  }

  async function writeBasePlan(confirmed: boolean) {
    if (!selectedCandidate?.basePlanDraft) return;
    setWriteMessage(undefined);
    try {
      if (isStaticPagesMode) {
        if (!confirmed) {
          setWriteMessage({
            kind: "base-plan",
            text: "Base-plan write needs explicit confirmation. Review the draft, then confirm to send it to Galactic Tycoons.",
            tone: "warn"
          });
          return;
        }
        try {
          const result = await writeStaticBasePlan(gtApiKey.trim(), selectedCandidate.basePlanDraft);
          setWriteMessage({
            kind: "base-plan",
            text: result.message,
            tone: result.status === "manual_only" ? "warn" : "ok"
          });
        } catch (caught) {
          setWriteMessage({
            kind: "base-plan",
            text: `${errorText(caught)} Use the manual draft below.`,
            tone: "warn"
          });
        }
        return;
      }
      const response = await fetch("/api/agent/base-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: selectedCandidate.basePlanDraft, confirmed })
      });
      if (!response.ok) throw await readApiError(response);
      const result = (await response.json()) as BasePlanWriteResult;
      setWriteMessage({
        kind: "base-plan",
        text: result.message,
        tone: result.status === "manual_only" ? "warn" : "ok"
      });
    } catch (caught) {
      setWriteMessage({ kind: "base-plan", text: errorText(caught), tone: "error" });
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>GT Build Planner</h1>
          <p>{plan ? `${plan.company.name} · ${formatMoney(plan.company.cash)}` : isStaticPagesMode ? "Hosted static Galactic Tycoons build console" : "Galactic Tycoons build console"}</p>
        </div>
        <div className={authenticated ? "status-pill ok" : "status-pill"}>
          <ShieldCheck size={16} aria-hidden="true" />
          {authenticated ? "Session active" : "No session"}
        </div>
      </header>

      {isStaticPagesMode && (
        <div className="notice hosted" role="status">
          <ShieldCheck size={18} aria-hidden="true" />
          Hosted mode keeps your API key only in this browser tab and sends requests directly to Galactic Tycoons.
        </div>
      )}

      <section className="control-band" aria-label="Planner controls">
        <label className="field key-field">
          <span>Galactic Tycoons API key</span>
          <div className="input-row">
            <KeyRound size={18} aria-hidden="true" />
            <input
              value={gtApiKey}
              onChange={(event) => setGtApiKey(event.target.value)}
              type="password"
              autoComplete="off"
              placeholder="gt_..."
            />
          </div>
        </label>
        <button className="icon-text" onClick={saveSession} disabled={loadingSession || gtApiKey.length < 8}>
          {loadingSession ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <Database size={17} aria-hidden="true" />}
          Save key
        </button>
        <label className="field compact">
          <span>Objective</span>
          <select value={objective} onChange={(event) => setObjective(event.target.value as Objective)}>
            {objectiveOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <NumberField label="Hours" value={horizonHours} min={1} max={168} onChange={setHorizonHours} />
        <NumberField label="Reserve %" value={cashReservePct} min={0} max={90} onChange={setCashReservePct} />
        <NumberField label="Max spend %" value={maxSpendPct} min={1} max={100} onChange={setMaxSpendPct} />
        <button className="primary-action" onClick={generatePlan} disabled={loadingPlan || gtApiKey.length < 8}>
          {loadingPlan ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <RefreshCw size={18} aria-hidden="true" />}
          Generate plan
        </button>
      </section>

      {error && (
        <div className="notice error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          {error}
        </div>
      )}

      {plan && selectedCandidate ? (
        <section className="workspace">
          <aside className="candidate-list" aria-label="Candidate list">
            <div className="section-title">
              <Target size={18} aria-hidden="true" />
              Candidates
            </div>
            {plan.candidates.map((candidate) => (
              <button
                key={candidate.id}
                className={candidate.id === selectedCandidate.id ? "candidate-card active" : "candidate-card"}
                onClick={() => setSelectedId(candidate.id)}
              >
                <span className="candidate-title">{candidate.title}</span>
                <span className="candidate-meta">
                  Score {candidate.score} · {candidate.confidence}
                </span>
              </button>
            ))}
          </aside>

          <section className="detail-surface" aria-label="Selected build plan">
            <div className="detail-heading">
              <div>
                <span className="eyebrow">{selectedCandidate.kind.replaceAll("_", " ")}</span>
                <h2>{selectedCandidate.title}</h2>
                <p>{selectedCandidate.summary}</p>
              </div>
              <div className="score-box">
                <span>{selectedCandidate.score}</span>
                <small>score</small>
              </div>
            </div>

            <div className="metric-grid">
              <Metric label="Estimated cost" value={formatMoney(selectedCandidate.estimatedCost)} />
              <Metric label="Cash after" value={formatMoney(selectedCandidate.cashAfter)} />
              <Metric label="Confidence" value={selectedCandidate.confidence} />
              <Metric label="Target" value={selectedCandidate.target.baseName ?? selectedCandidate.target.outputMatName ?? "Account-wide"} />
            </div>

            <ScoreBreakdown candidate={selectedCandidate} />
            <MessageList title="Rationale" items={selectedCandidate.rationale} />
            <MessageList title="Blockers" items={selectedCandidate.blockers} tone="warn" />
            <MessageList title="Warnings" items={[...selectedCandidate.warnings, ...plan.warnings]} tone="warn" />

            <RequirementsTable candidate={selectedCandidate} />

            <div className="write-grid">
              <WritePanel
                kind="wishlist"
                title="Wishlist"
                disabled={!selectedCandidate.wishlistManifest}
                confirmed={confirmWishlist}
                onConfirmChange={setConfirmWishlist}
                onPreview={() => writeWishlist(false)}
                onWrite={() => writeWishlist(true)}
              />
              <WritePanel
                kind="base-plan"
                title="Base Plan"
                disabled={!selectedCandidate.basePlanDraft}
                confirmed={confirmBasePlan}
                onConfirmChange={setConfirmBasePlan}
                onPreview={() => writeBasePlan(false)}
                onWrite={() => writeBasePlan(true)}
              />
            </div>

            {writeMessage && (
              <div className={`notice ${writeMessage.tone}`} role="status">
                {writeMessage.tone === "ok" ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}
                {writeMessage.text}
              </div>
            )}

            {selectedCandidate.basePlanDraft && <BasePlanDraftView candidate={selectedCandidate} />}
          </section>
        </section>
      ) : (
        <section className="empty-state">
          <Zap size={24} aria-hidden="true" />
          <h2>Ready for live company data</h2>
        </section>
      )}
    </main>
  );
}

function NumberField(props: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="field number">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function ScoreBreakdown({ candidate }: { candidate: BuildCandidate }) {
  const rows = Object.entries(candidate.scoreBreakdown);
  return (
    <section className="score-breakdown" aria-label="Score breakdown">
      {rows.map(([key, value]) => (
        <div key={key}>
          <span>{labelize(key)}</span>
          <meter min={-20} max={50} value={value} />
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function MessageList({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  const filtered = items.filter(Boolean);
  if (!filtered.length) return null;
  return (
    <section className={tone === "warn" ? "message-list warn" : "message-list"}>
      <h3>{title}</h3>
      <ul>
        {filtered.slice(0, 6).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
      </ul>
    </section>
  );
}

function RequirementsTable({ candidate }: { candidate: BuildCandidate }) {
  if (candidate.requirements.length === 0) return null;
  return (
    <section className="table-section">
      <div className="section-title">
        <ClipboardList size={18} aria-hidden="true" />
        Materials
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Material</th>
              <th>Required</th>
              <th>Owned</th>
              <th>Missing</th>
              <th>Cost</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {candidate.requirements.map((item) => (
              <tr key={item.matId}>
                <td>{item.matName}</td>
                <td>{formatQty(item.requiredQty)}</td>
                <td>{formatQty(item.ownedQty)}</td>
                <td>{formatQty(item.deficitQty)}</td>
                <td>{item.estimatedCost === undefined ? "n/a" : formatMoney(item.estimatedCost)}</td>
                <td>{item.priceSource}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WritePanel(props: {
  kind: "wishlist" | "base-plan";
  title: string;
  disabled: boolean;
  confirmed: boolean;
  onConfirmChange: (value: boolean) => void;
  onPreview: () => void;
  onWrite: () => void;
}) {
  return (
    <section className="write-panel">
      <div>
        <h3>{props.title}</h3>
        <p>{props.disabled ? "No draft for selected candidate" : "Manual preview or confirmed API write"}</p>
      </div>
      <div className="write-actions">
        <button className="secondary" onClick={props.onPreview} disabled={props.disabled}>
          <ClipboardList size={16} aria-hidden="true" />
          Preview
        </button>
        <label className="check-row">
          <input
            type="checkbox"
            checked={props.confirmed}
            onChange={(event) => props.onConfirmChange(event.target.checked)}
            disabled={props.disabled}
          />
          Confirm
        </label>
        <button className="secondary danger" onClick={props.onWrite} disabled={props.disabled || !props.confirmed}>
          <Save size={16} aria-hidden="true" />
          Write
        </button>
      </div>
    </section>
  );
}

function BasePlanDraftView({ candidate }: { candidate: BuildCandidate }) {
  if (!candidate.basePlanDraft) return null;
  return (
    <section className="draft-view">
      <div className="section-title">
        <Save size={18} aria-hidden="true" />
        Base plan draft
      </div>
      <div className="slot-grid">
        {candidate.basePlanDraft.slots.slice(0, 25).map((slot) => (
          <div key={slot.id} className={slot.buildingType > 0 ? "slot planned" : "slot"}>
            <span>{slot.id}</span>
            <strong>{slot.buildingType || "-"}</strong>
            <small>L{slot.level}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

async function readApiError(response: Response): Promise<ApiError> {
  try {
    return (await response.json()) as ApiError;
  } catch {
    return { error: `Request failed with ${response.status}.` };
  }
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error && "error" in error) return String((error as ApiError).error);
  return error instanceof Error ? error.message : "Request failed.";
}

function labelize(value: string): string {
  return value.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`).replace(/^./, (match) => match.toUpperCase());
}

function formatMoney(cents: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(cents / 100))} cr`;
}

function formatQty(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}
