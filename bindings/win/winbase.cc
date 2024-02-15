#define WIN32_LEAN_AND_MEAN

#include <napi.h>
#include <windows.h>
#include <winbase.h>

//
Napi::Value disablePowerSaving(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  
  if (info.Length() < 1) { 
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  bool enable = info[0].As<Napi::Boolean>();
  
  try {
    if (enable) {
        EXECUTION_STATE res = SetThreadExecutionState( ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED );
        return Napi::Boolean::New( env, true);

    } else {
        EXECUTION_STATE res = SetThreadExecutionState( ES_CONTINUOUS);
        return Napi::Boolean::New( env, true);
    }

    return Napi::String::New(env, "unblock");  
  }
  catch (...) { 
    return env.Null();    
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "disablePowerSaving"),
              Napi::Function::New(env, disablePowerSaving));
  return exports;
}

NODE_API_MODULE(winbase, Init)