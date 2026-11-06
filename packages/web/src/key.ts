/**
 * The key in this browser: a P-256 key it makes for itself the first time, the way the PureStrings button makes
 * one in its flash. The private half is made non-extractable, so no script (PureStrings' own included) can read
 * it out; it's kept in this browser's IndexedDB and only ever asked to sign. PureStrings and shops get the public
 * half: the raw uncompressed point, base64url, as the button sends it.
 *
 * A key in a browser is only as safe as the browser: it's for trying PureStrings without the button.
 */

export interface BrowserKey {
  /** The public point, base64url. */
  readonly key: string;
  /** The first 8 bytes of SHA-256(point), in hex fours: the same here, in PureStrings and on the button. */
  readonly fingerprint: string;
  /** False when this browser can't keep it (a private window, storage blocked): it's new on every visit. */
  readonly kept: boolean;
  /** This key's signature of exactly this text: ECDSA P-256 over SHA-256 of its UTF-8, r‖s, base64url. */
  sign(text: string): Promise<string>;
}

const DB = "purestrings-key";
const STORE = "keys";
const ID = "key";

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** "1A2B 3C4D 5E6F 7A8B" from a key's SHA-256. */
export function fingerprintOf(hash: Uint8Array): string {
  const hex = [...hash.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}

/** A key from a key pair: what it says, and how it signs. */
export async function keyOf(pair: CryptoKeyPair, kept: boolean, subtle: SubtleCrypto = crypto.subtle): Promise<BrowserKey> {
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const hash = new Uint8Array(await subtle.digest("SHA-256", raw));
  return {
    key: base64url(raw),
    fingerprint: fingerprintOf(hash),
    kept,
    sign: async (text) => base64url(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(text)))),
  };
}

/** A new key pair; the private half can sign but never be read out. */
export const makeKeyPair = (subtle: SubtleCrypto = crypto.subtle): Promise<CryptoKeyPair> => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;

function request<T>(make: (db: IDBDatabase) => IDBRequest<T> | IDBTransaction): Promise<T> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    opening.onerror = () => reject(opening.error ?? new Error("IndexedDB didn't open."));
    opening.onsuccess = () => {
      const db = opening.result;
      const made = make(db);
      if (made instanceof IDBTransaction) {
        made.oncomplete = () => (db.close(), resolve(undefined as T));
        made.onerror = () => (db.close(), reject(made.error ?? new Error("IndexedDB didn't save.")));
      } else {
        made.onsuccess = () => (db.close(), resolve(made.result));
        made.onerror = () => (db.close(), reject(made.error ?? new Error("IndexedDB didn't read.")));
      }
    };
  });
}

let loading: Promise<BrowserKey> | null = null;

/** This browser's key, made the first time; one that can't be kept lasts until the page closes. */
export function loadKey(): Promise<BrowserKey> {
  loading ??= (async () => {
    try {
      const held = await request<CryptoKeyPair | undefined>((db) => db.transaction(STORE, "readonly").objectStore(STORE).get(ID));
      if (held?.privateKey && held.publicKey) return await keyOf(held, true);
      const pair = await makeKeyPair();
      await request((db) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put(pair, ID);
        return transaction;
      });
      return await keyOf(pair, true);
    } catch {
      return keyOf(await makeKeyPair(), false);
    }
  })();
  return loading;
}

/** Forgets this browser's key, so the next one is new. */
export async function forgetKey(): Promise<void> {
  loading = null;
  try {
    await request((db) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(ID);
      return transaction;
    });
  } catch {
    // Nothing kept to forget.
  }
}
