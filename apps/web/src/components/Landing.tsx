import { BrandMark } from "./BrandMark";
import type { User } from "../lib/api";

export function Landing({ user, onEnter, onAuth }: { user: User | null; onEnter(): void; onAuth(): void }) {
  return <main className="landing">
    <header className="landing-nav"><a className="landing-brand" href="/"><BrandMark small /><span>Horcrux</span></a><nav>{user ? <><button onClick={onEnter}>Open Horcrux</button><span className="nav-user">{user.email}</span></> : <><button onClick={onAuth}>Log in</button><button className="ink-button" onClick={onAuth}>Get started</button></>}</nav></header>
    <section className="landing-hero">
      <div className="hero-copy"><p className="kicker">Private storage, deliberately fractured</p><h1>Break your files apart.<br /><em>Keep what matters whole.</em></h1><p className="hero-lede">Horcrux encrypts your file in the browser, divides it among five independent nodes, and restores it when any three remain.</p><div className="hero-actions"><button className="ink-button" onClick={user ? onEnter : onAuth}>{user ? "Open Horcrux" : "Begin with a file"}</button><a href="#method">See the method <span aria-hidden="true">↓</span></a></div></div>
      <div className="artifact" aria-hidden="true"><div className="artifact-core">H</div>{["I", "II", "III", "IV", "V"].map((label, index) => <i key={label} className={`fragment fragment-${index + 1}`}>{label}</i>)}<p>five fragments · three enough</p></div>
    </section>
    <section className="ritual" id="method"><p className="kicker">A small ritual, performed locally</p><div className="ritual-line"><span>compress</span><b>·</b><span>encrypt</span><b>·</b><span>split</span><b>·</b><span>distribute</span></div><p>The control plane handles identity, placement, and authorization. Your plaintext, AES key, encrypted shard bytes, and secret shares never pass through it.</p></section>
    <section className="survival"><div><p className="kicker">Designed for absence</p><h2>Lose two.<br />Keep everything.</h2><p>Three surviving fragments reconstruct the original file. Not optimism—an explicit 3-of-5 recovery design.</p></div><div className="node-table" aria-label="Five node recovery example">{["alive", "missing", "alive", "missing", "alive"].map((state, index) => <div key={index} className={state}><span>node {index + 1}</span><strong>{state === "alive" ? "✦" : "×"}</strong></div>)}<p>3 fragments remain → file restored</p></div></section>
    <section className="technical"><p className="kicker">The machinery, if you want it</p><p>zstd compression · AES-256-GCM encryption · Reed–Solomon 3+2 shards · Shamir 3-of-5 key shares</p><small>Horcrux is under active development. Today it is designed for local and LAN HTTP storage nodes; global peer connectivity is future work.</small></section>
    <footer><span>Horcrux</span><button className="ink-button" onClick={user ? onEnter : onAuth}>{user ? "Open Horcrux" : "Get started"}</button></footer>
  </main>;
}
