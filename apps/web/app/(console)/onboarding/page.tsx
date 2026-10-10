import { MintTokenButton } from "./mint-token-button";

export default function OnboardingPage(): React.JSX.Element {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Onboarding</h1>
      <p className="mt-1 max-w-xl text-sm text-gray-500">
        Mint a single-use init token for a new agent. The 6-digit code is shown
        once — hand it to the agent out of band.
      </p>
      <div className="mt-4">
        <MintTokenButton />
      </div>
    </div>
  );
}
