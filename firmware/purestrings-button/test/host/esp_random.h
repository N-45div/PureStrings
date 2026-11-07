// The button's random bytes, from the computer's: getrandom on Linux, the system's source elsewhere.
#pragma once
#include <cstddef>
#if defined(__linux__)
#include <sys/random.h>
inline void esp_fill_random(void *out, size_t length) {
  unsigned char *bytes = static_cast<unsigned char *>(out);
  while (length > 0) {
    ssize_t got = getrandom(bytes, length, 0);
    if (got <= 0) continue;
    bytes += got;
    length -= static_cast<size_t>(got);
  }
}
#else
#include <random>
inline void esp_fill_random(void *out, size_t length) {
  static std::random_device source;
  unsigned char *bytes = static_cast<unsigned char *>(out);
  for (size_t i = 0; i < length; i++) bytes[i] = static_cast<unsigned char>(source());
}
#endif
