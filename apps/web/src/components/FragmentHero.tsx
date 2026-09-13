import { useEffect, useRef } from "react";

/** Progressive-enhancement WebGL explanation of the 3-of-5 recovery model. */
export function FragmentHero() {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = mount.current;
    if (!host || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let disposed = false;
    let cleanup = () => {};
    void import("three").then((THREE) => {
      if (disposed || !host) return;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, .1, 100); camera.position.z = 8;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); host.append(renderer.domElement);
      const material = new THREE.MeshStandardMaterial({ color: 0x29362b, roughness: .48, metalness: .24 });
      const geometry = new THREE.IcosahedronGeometry(1.38, 1); const pieces = Array.from({ length: 5 }, () => {
        const mesh = new THREE.Mesh(geometry, material.clone()); scene.add(mesh); return mesh;
      });
      scene.add(new THREE.AmbientLight(0xf8edcf, 2.2)); const light = new THREE.DirectionalLight(0xd4a35f, 3); light.position.set(3, 4, 5); scene.add(light);
      const resize = () => { const { width, height } = host.getBoundingClientRect(); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
      const targets = [[0, 1.8, 0], [1.7, .55, .1], [1.05, -1.4, 0], [-1.1, -1.4, 0], [-1.7, .55, .1]];
      let pointerX = 0, pointerY = 0, active = true, frame = 0;
      const move = (event: PointerEvent) => { const rect = host.getBoundingClientRect(); pointerX = (event.clientX - rect.left) / rect.width - .5; pointerY = (event.clientY - rect.top) / rect.height - .5; };
      const observer = new IntersectionObserver(([entry]) => { active = Boolean(entry?.isIntersecting); }); observer.observe(host); addEventListener("pointermove", move, { passive: true }); addEventListener("resize", resize); resize();
      const render = () => { if (!disposed) frame = requestAnimationFrame(render); if (!active) return; const scroll = Math.min(1, Math.max(0, (innerHeight - host.getBoundingClientRect().top) / (innerHeight + host.clientHeight))); const phase = Math.min(1, scroll * 1.45); pieces.forEach((mesh, index) => { const [x, y, z] = targets[index]!; const vanish = (index === 1 || index === 3) ? Math.max(0, Math.min(1, (phase - .42) / .22)) : 0; const reform = Math.max(0, Math.min(1, (phase - .68) / .32)); const spread = phase < .72 ? phase / .72 : 1 - reform; mesh.position.set(x! * spread, y! * spread, z! * spread); mesh.scale.setScalar((1 - vanish) * (1 - .12 * spread)); mesh.rotation.set(phase * (index + 1) * .45 + pointerY * .18, phase * (index - 2) * .5 + pointerX * .2, 0); mesh.visible = vanish < .98; }); scene.rotation.y = pointerX * .25; scene.rotation.x = -pointerY * .15; renderer.render(scene, camera); };
      render(); cleanup = () => { cancelAnimationFrame(frame); observer.disconnect(); removeEventListener("pointermove", move); removeEventListener("resize", resize); geometry.dispose(); pieces.forEach((mesh) => mesh.material.dispose()); renderer.dispose(); renderer.domElement.remove(); };
    }).catch(() => { host.dataset.webgl = "unavailable"; });
    return () => { disposed = true; cleanup(); };
  }, []);
  return <div ref={mount} className="fragment-webgl" aria-hidden="true" />;
}
