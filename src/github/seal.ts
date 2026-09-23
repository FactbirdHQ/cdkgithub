import sodium from 'libsodium-wrappers';

/**
 * Seal a secret value for GitHub's Actions secrets endpoints.
 *
 * GitHub only accepts secret values encrypted to the repository's or
 * organization's public key with libsodium's sealed box, so the plaintext
 * never travels: it is encrypted here, in process, and only the ciphertext is
 * sent. The key comes from the matching `.../actions/secrets/public-key`
 * endpoint, base64 as GitHub serves it.
 */
export async function sealSecretValue(
  publicKeyBase64: string,
  value: string,
): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(
    publicKeyBase64,
    sodium.base64_variants.ORIGINAL,
  );
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
