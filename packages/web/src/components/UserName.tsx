import { createContext, useContext, type ReactNode } from 'react';
import { describeUser, type UserMap } from '../model.ts';

export interface UsersState {
  /** Every user by id, as `GET /users` last listed them; empty until loaded. */
  users: UserMap;
  /** Loads the users again, e.g. after a rename. */
  reload: () => void;
}

const UsersContext = createContext<UsersState>({ users: new Map(), reload: () => {} });

/** Makes the users known to every `UserName` below it. */
export function UsersProvider({ users, reload = () => {}, children }: { users: UserMap; reload?: () => void; children: ReactNode }) {
  return <UsersContext.Provider value={{ users, reload }}>{children}</UsersContext.Provider>;
}

export const useUsers = (): UsersState => useContext(UsersContext);

/**
 * A person by the current display name of the user with id `id`, with its
 * username and id on hover; see `describeUser` for unknown and missing ids.
 */
export function UserName({ id }: { id: string | undefined }) {
  const label = describeUser(id, useUsers().users);
  return (
    <span className={`user-name user-${label.kind}`} title={label.title}>
      {label.text}
    </span>
  );
}
