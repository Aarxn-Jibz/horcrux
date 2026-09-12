export function BrandMark({ small = false }: { small?: boolean }) {
  return <img className={`brand-mark${small ? " small" : ""}`} src="/horcrux-locket.png" alt="" aria-hidden="true" />;
}
