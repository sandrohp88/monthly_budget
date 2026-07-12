import * as React from "react";
import { cn } from "@/lib/cn";
import { cardArtSrc, cardBrand, cardMaskDigits, cardNetwork } from "@/lib/card-art";

/**
 * A physical credit card, wallet-style: official issuer art when we have it,
 * otherwise a brand-colored fallback face with wordmark, chip, mask, and
 * network mark. Fixed ISO ID-1 aspect ratio (85.6 × 53.98 mm ≈ 1.586).
 */
export function CreditCardVisual({
  name,
  institution,
  mask,
  className,
  children,
}: {
  name: string;
  institution?: string | null;
  mask?: string | null;
  className?: string;
  /** Optional overlay (status pill etc.) rendered above the card face. */
  children?: React.ReactNode;
}) {
  const art = cardArtSrc(name);
  const digits = cardMaskDigits(name, mask);

  return (
    <div
      className={cn(
        "relative aspect-[1586/1000] w-full select-none overflow-hidden rounded-xl",
        className,
      )}
    >
      {art ? (
        // eslint-disable-next-line @next/next/no-img-element -- static local card art, no optimization needed
        <img
          src={art}
          alt={name}
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <FallbackFace name={name} institution={institution} digits={digits} />
      )}
      {/* hairline edge so light art holds its shape on light themes */}
      <div className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-black/10 dark:ring-white/10" />
      {children}
    </div>
  );
}

function FallbackFace({
  name,
  institution,
  digits,
}: {
  name: string;
  institution?: string | null;
  digits: string | null;
}) {
  const brand = cardBrand(name, institution);
  const network = cardNetwork(name);

  return (
    <div
      className="absolute inset-0 flex flex-col justify-between p-[7%]"
      style={{ background: brand.background, color: brand.foreground }}
    >
      {/* brushed-sheen highlight */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(130% 90% at 88% -12%, rgba(255,255,255,0.16), transparent 58%)," +
            "linear-gradient(115deg, transparent 42%, rgba(255,255,255,0.05) 47%, transparent 54%)",
        }}
      />
      <div className="flex items-start justify-between">
        <span
          className={cn(
            "max-w-[70%] truncate text-[16px] font-bold leading-tight tracking-wide",
            !brand.preserveCase && "uppercase",
          )}
        >
          {brand.wordmark}
        </span>
        <Chip />
      </div>
      <div className="flex items-end justify-between">
        <span className="text-[13px] font-semibold tracking-[0.18em] opacity-90 tabular">
          {digits ? `••••  ${digits}` : "••••  ••••"}
        </span>
        {network ? (
          <span
            className={cn(
              "text-[13px] font-extrabold tracking-wide opacity-85",
              network === "VISA" && "italic",
            )}
          >
            {network}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Chip() {
  return (
    <svg width="34" height="25" viewBox="0 0 34 25" aria-hidden className="mt-0.5 shrink-0 opacity-90">
      <rect
        x="0.75"
        y="0.75"
        width="32.5"
        height="23.5"
        rx="4.5"
        fill="rgba(255,255,255,0.18)"
        stroke="rgba(255,255,255,0.45)"
        strokeWidth="1.2"
      />
      <path
        d="M0.75 8.5h9.5M0.75 16.5h9.5M23.75 8.5h9.5M23.75 16.5h9.5M13 0.75v6.5a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3v-6.5M13 24.25v-6.5a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v6.5"
        fill="none"
        stroke="rgba(255,255,255,0.45)"
        strokeWidth="1.2"
      />
    </svg>
  );
}
