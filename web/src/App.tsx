import { useMemo, useState } from "react";
import { StepBar, type StepDef } from "./components/StepBar";
import { StatusBadge } from "./components/StatusBadge";
import { VENDORS } from "./types";
import type {
  ApplyResult,
  ConnInfo,
  Design,
  DeviceInventory,
  ImportResult,
  NgfwSettings,
  PlanDiff,
  PolicyPack,
  ProtectionSettings,
  TargetConfig,
  Validation,
  Vendor,
  VerifyResult,
} from "./types";

import { ConnectStep } from "./steps/ConnectStep";
import { DiscoveryStep } from "./steps/DiscoveryStep";
import { DesignStep } from "./steps/DesignStep";
import { ImportStep } from "./steps/ImportStep";
import { PacksStep } from "./steps/PacksStep";
import { NgfwStep } from "./steps/NgfwStep";
import { PlanStep } from "./steps/PlanStep";
import { ApplyStep } from "./steps/ApplyStep";
import { VerifyStep } from "./steps/VerifyStep";

const STEPS: StepDef[] = [
  { key: "connect", label: "Connect", hint: "Target & transport" },
  { key: "discover", label: "Discover", hint: "Read-only scan + backup" },
  { key: "design", label: "Design", hint: "Zones · DNS · NTP" },
  { key: "import", label: "Import", hint: "NAT / ACL / VPN (AI)" },
  { key: "packs", label: "Policy packs", hint: "Best-practice baseline" },
  { key: "ngfw", label: "NGFW & hardening", hint: "IPS · URL · protection" },
  { key: "plan", label: "Plan", hint: "Full change diff" },
  { key: "apply", label: "Apply", hint: "Live or staged" },
  { key: "verify", label: "Verify", hint: "Read device back" },
];

/** The whole onboarding session lives in one state object passed to each step. */
export interface WizardState {
  sessionId: string | null;
  target: TargetConfig;
  conn: ConnInfo | null;
  inventory: DeviceInventory | null;
  design: Design;
  imports: ImportResult[];
  packs: PolicyPack[];
  ngfw: NgfwSettings;
  protection: ProtectionSettings;
  plan: PlanDiff | null;
  validation: Validation | null;
  applyResult: ApplyResult | null;
  verifyResult: VerifyResult | null;
}

function initialState(): WizardState {
  return {
    sessionId: null,
    target: {
      vendor: "panos",
      transport: "direct",
      credentials: {},
    },
    conn: null,
    inventory: null,
    design: {
      zones: [],
      dns: [],
      ntp: [],
      management: {
        allowedSources: [],
        https: true,
        ssh: true,
        telnet: false,
        httpPlain: false,
      },
    },
    imports: [],
    packs: [],
    ngfw: {
      ips: true,
      antiMalware: true,
      sandboxing: false,
      urlFiltering: true,
      dnsSecurity: true,
      tlsDecryption: false,
    },
    protection: {
      floodProtection: true,
      reconProtection: true,
      packetBasedAttackProtection: true,
      antiSpoofing: true,
      bogonFiltering: true,
      rfc1918EgressFilter: false,
    },
    plan: null,
    validation: null,
    applyResult: null,
    verifyResult: null,
  };
}

export default function App() {
  const [state, setState] = useState<WizardState>(initialState);
  const [current, setCurrent] = useState(0);
  const [furthest, setFurthest] = useState(0);

  const patch = (next: Partial<WizardState>) =>
    setState((prev) => ({ ...prev, ...next }));

  const goTo = (i: number) => {
    const clamped = Math.max(0, Math.min(STEPS.length - 1, i));
    setCurrent(clamped);
    setFurthest((f) => Math.max(f, clamped));
  };
  const next = () => goTo(current + 1);
  const back = () => goTo(current - 1);

  const vendorMeta = useMemo(
    () => VENDORS.find((v) => v.id === state.target.vendor) ?? VENDORS[0],
    [state.target.vendor],
  );

  const setVendor = (vendor: Vendor) =>
    patch({
      target: { ...state.target, vendor, credentials: {} },
      conn: null,
    });

  const total = STEPS.length;
  const stepProps = { state, patch, onNext: next, onBack: back, step: current + 1, total };

  const renderStep = () => {
    switch (STEPS[current].key) {
      case "connect":
        return <ConnectStep {...stepProps} setVendor={setVendor} />;
      case "discover":
        return <DiscoveryStep {...stepProps} />;
      case "design":
        return <DesignStep {...stepProps} />;
      case "import":
        return <ImportStep {...stepProps} />;
      case "packs":
        return <PacksStep {...stepProps} />;
      case "ngfw":
        return <NgfwStep {...stepProps} />;
      case "plan":
        return <PlanStep {...stepProps} />;
      case "apply":
        return <ApplyStep {...stepProps} />;
      case "verify":
        return <VerifyStep {...stepProps} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar — terminal-style identity */}
      <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-3">
            <BastionMark />
            <div className="leading-none">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold tracking-tight text-slate-100">
                  Bastion
                </span>
                <span className="eyebrow">firewall onboarding</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge tone="accent" dot>
              {vendorMeta.label}
            </StatusBadge>
            {state.sessionId ? (
              <StatusBadge tone="good" dot>
                session {state.sessionId.slice(0, 8)}
              </StatusBadge>
            ) : (
              <StatusBadge tone="neutral">no session</StatusBadge>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1500px] flex-1 gap-8 px-5 py-7">
        {/* Pipeline spine */}
        <aside className="w-full shrink-0 md:w-60">
          <div className="md:sticky md:top-20">
            <div className="eyebrow mb-3 hidden md:block">Build pipeline</div>
            <StepBar steps={STEPS} current={current} furthest={furthest} onJump={goTo} />
            <p className="mt-6 hidden border-t border-ink-800 pt-4 text-[11px] leading-relaxed text-ink-600 md:block">
              Read before write. Nothing is committed until you see the full diff and
              confirm.
            </p>
          </div>
        </aside>

        {/* Active step */}
        <main className="min-w-0 flex-1">{renderStep()}</main>
      </div>
    </div>
  );
}

/** Shared props every step receives. */
export interface StepProps {
  state: WizardState;
  patch: (next: Partial<WizardState>) => void;
  onNext: () => void;
  onBack: () => void;
  step: number;
  total: number;
}

function BastionMark() {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-md border border-accent/40 bg-accent-soft/40">
      <svg width="16" height="18" viewBox="0 0 16 18" fill="none" aria-hidden>
        <path
          d="M8 1L14.5 3.5V8.5C14.5 12.5 11.8 15.6 8 17C4.2 15.6 1.5 12.5 1.5 8.5V3.5L8 1Z"
          stroke="#4f9cf9"
          strokeWidth="1.3"
          fill="rgba(79,156,249,0.08)"
        />
        <path d="M8 5.5V12M5 8.75H11" stroke="#4f9cf9" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </span>
  );
}
