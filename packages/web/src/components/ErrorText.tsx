export function ErrorText({ message }: { message: string | undefined }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}
