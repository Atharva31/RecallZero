import Link from "next/link";

const STORES = ["STORE-A", "STORE-B", "STORE-C", "STORE-D", "STORE-E", "STORE-F"];

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8 space-y-4">
      <h1 className="text-2xl font-semibold">RecallZero</h1>
      <p>
        <Link className="underline" href="/command">
          Command center
        </Link>
      </p>
      <ul className="space-y-1">
        {STORES.map((id) => (
          <li key={id}>
            <Link className="underline" href={`/store/${id}`}>
              {id} terminal
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
