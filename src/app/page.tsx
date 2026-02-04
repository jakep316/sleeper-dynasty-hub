export default function Home() {
  return (
    <div style={{ padding: 24 }}>
      <h1>🏈 Dynasty Hub</h1>

      <ul>
        <li><a href="/transactions">Transactions</a></li>
        <li><a href="/h2h">Head-to-Head Records</a></li>
      </ul>

      <p style={{ marginTop: 12, opacity: 0.7 }}>
        Sleeper dynasty history tracker
      </p>
    </div>
  );
}
