// The button's own signing code (key.h), built on a computer against mbedTLS, so PureStrings' tests can check
// what it says and signs without the button. Reads a text on stdin; prints the key it made, its fingerprint, and
// its signature of the text twice (deterministic, so the same both times), one per line.
#include <mbedtls/sha256.h>
#include <mbedtls/version.h>
#if MBEDTLS_VERSION_MAJOR < 3
// The button's mbedTLS is 3.x; a computer's may be 2.x, which names two things differently.
#include <mbedtls/ecp.h>
// mbedTLS 2 calls the int-returning one this; mbedTLS 3 calls it mbedtls_sha256.
#define mbedtls_sha256 mbedtls_sha256_ret
// mbedTLS 3's, which mbedTLS 2 doesn't have: a key pair's group, private scalar and public point, copied out.
inline int mbedtls_ecp_export(const mbedtls_ecp_keypair *key, mbedtls_ecp_group *grp, mbedtls_mpi *d, mbedtls_ecp_point *q) {
  int failed = mbedtls_ecp_group_copy(grp, &key->grp);
  if (!failed) failed = mbedtls_mpi_copy(d, &key->d);
  if (!failed) failed = mbedtls_ecp_copy(q, &key->Q);
  return failed;
}
#endif
#include "../../key.h"

#include <iostream>
#include <iterator>

int main() {
  Preferences prefs;  // empty, as at a button's first start
  if (!chipkey::load(prefs)) {
    fprintf(stderr, "the button couldn't make its key\n");
    return 1;
  }
  if (!chipkey::selfCheck()) {
    fprintf(stderr, "the button's key failed its own check\n");
    return 2;
  }
  // Started again, it reads the same key back from its flash.
  String made = chipkey::keyText;
  if (chipkey::load(prefs) || chipkey::keyText != made) {
    fprintf(stderr, "the button didn't keep its key\n");
    return 3;
  }
  std::string text((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
  printf("%s\n%s\n%s\n%s\n", chipkey::keyText.c_str(), chipkey::fingerprint.c_str(), chipkey::sign(String(text)).c_str(), chipkey::sign(String(text)).c_str());
  return 0;
}
