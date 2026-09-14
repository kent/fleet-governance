import ConfigForm from "../components/ConfigForm.js";

export default function HomePage() {
  return (
    <main>
      <h1>Fleet Governance Runner</h1>
      <p>Configure an experiment run, then press Run.</p>
      <ConfigForm />
    </main>
  );
}
