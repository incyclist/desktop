#include <napi.h>
//
Napi::Value disablePowerSaving(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return env.Null();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "disablePowerSaving"),
              Napi::Function::New(env, disablePowerSaving));
  return exports;
}

NODE_API_MODULE(winbase, Init)