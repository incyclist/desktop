{
  "targets": [
    {
      "target_name": "winbase",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "conditions": [
        ['OS=="win"', 
          {
            "sources": [ "bindings/win/winbase.cc" ],
            "include_dirs": [
              "<!@(node -p \"require('node-addon-api').include\")"
            ]
          }
        ],
        ['OS=="max"', 
          {
            "sources": [ "bindings/mac/winbase.cc" ],
            "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
            ]
          }
        ],
        ['OS=="linux"', 
          {
            "sources": [ "bindings/linux/winbase.cc" ],
            "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
            ]
          }
        ]
      ],       
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
    }
  ]
}