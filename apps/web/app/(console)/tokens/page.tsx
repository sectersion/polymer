import { fetchTokens } from "@/lib/polymer";
import { RotateMasterButton } from "./rotate-master-button";
import { TokensTable } from "./tokens-table";

export default async function TokensPage(): Promise<React.JSX.Element> {
  const tokens = await fetchTokens();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Tokens</h1>
      <p className="mt-1 text-sm text-gray-500">
        Credential metadata only — no secret material is ever rendered.
      </p>
      <TokensTable tokens={tokens} />
      <div className="mt-6">
        <RotateMasterButton />
      </div>
    </div>
  );
}
