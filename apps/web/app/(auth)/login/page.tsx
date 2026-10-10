import { LoginForm } from "./login-form";

export default function LoginPage(): React.JSX.Element {
  return (
    <div className="mx-auto mt-24 max-w-sm rounded-lg border border-(--color-hairline) bg-(--color-card) p-6 shadow-sm">
      <h1 className="text-xl font-semibold tracking-tight">
        Log in to Polymer
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        Username-free: one password field for the master credential.
      </p>
      <LoginForm />
    </div>
  );
}
