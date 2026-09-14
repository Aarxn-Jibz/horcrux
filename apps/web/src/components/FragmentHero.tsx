import { useEffect, useRef } from "react";

export function FragmentHero() {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = mount.current;
    if (!host || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let dead = false; let frame = 0;
    void import("three").then((T) => {
      if (dead || !host) return;
      const scene = new T.Scene(); const camera = new T.PerspectiveCamera(36, 1, .1, 100); camera.position.z = 8;
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); host.append(renderer.domElement);
      const shape = new T.Shape(); for (let i = 0; i < 10; i += 1) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 1.2 : 2; i ? shape.lineTo(Math.cos(a) * r, Math.sin(a) * r) : shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); } shape.closePath();
      const geometry = new T.ExtrudeGeometry(shape, { depth: .35, bevelEnabled: true, bevelSize: .04, bevelThickness: .04 }); geometry.center();
      const group = new T.Group(); scene.add(group); const pieces = Array.from({ length: 5 }, (_, i) => { const mesh = new T.Mesh(geometry, new T.MeshStandardMaterial({ color: 0xc9fa52, emissive: 0x263d10, emissiveIntensity: .5, roughness: .3, metalness: .65 })); mesh.rotation.z = i * Math.PI * 2 / 5; group.add(mesh); return mesh; });
      scene.add(new T.AmbientLight(0x638c40, 1.8)); const light = new T.PointLight(0xe6ff80, 35, 15); light.position.set(2, 3, 4); scene.add(light);
      const points = [[0,1.8],[1.75,.45],[1.08,-1.58],[-1.08,-1.58],[-1.75,.45]]; let active = true;
      const observer = new IntersectionObserver(([entry]) => { active = Boolean(entry?.isIntersecting); }); observer.observe(host);
      const resize = () => { const { width, height } = host.getBoundingClientRect(); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); }; addEventListener("resize", resize); resize();
      const render = () => { if (!dead) frame = requestAnimationFrame(render); if (!active) return; const phase = (performance.now() / 10000) % 1, spread = Math.min(1, phase / .3, (1 - phase) / .24), reform = Math.max(0, (phase - .72) / .28); pieces.forEach((mesh, i) => { const [x, y] = points[i]!; const vanish = i === 1 || i === 3 ? Math.max(0, Math.min(1, (phase - .36) / .18)) : 0; mesh.position.set(x! * spread * (1 - reform), y! * spread * (1 - reform), -vanish); mesh.scale.setScalar(1 - vanish); mesh.visible = vanish < .98; }); group.rotation.y = phase * Math.PI * 2; renderer.render(scene, camera); }; render();
      (host as HTMLElement & { dispose?: () => void }).dispose = () => { cancelAnimationFrame(frame); observer.disconnect(); removeEventListener("resize", resize); geometry.dispose(); pieces.forEach((piece) => (piece.material as { dispose(): void }).dispose()); renderer.dispose(); renderer.domElement.remove(); };
    }).catch(() => { host.dataset.webgl = "unavailable"; });
    return () => { dead = true; (host as HTMLElement & { dispose?: () => void }).dispose?.(); };
  }, []);
  return <div ref={mount} className="fragment-webgl" aria-hidden="true" />;
}
