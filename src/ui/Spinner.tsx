// Extracted from App.tsx (code-audit item A-1).

export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ display: "inline-block", verticalAlign: "middle" }}
      aria-hidden="true"
    >
      {/* faint full ring */}
      <circle
        cx="12" cy="12" r="9"
        fill="none" stroke="currentColor"
        strokeOpacity="0.25" strokeWidth="3"
      />
      {/* bright arc that rotates */}
      <path
        d="M12 3 a9 9 0 0 1 9 9"
        fill="none" stroke="currentColor"
        strokeWidth="3" strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12" to="360 12 12"
          dur="0.7s" repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}
