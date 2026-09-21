export const jcsVectors = [
  {
    "id": "rfc8785-utf16-key-order-adapted",
    "kind": "json",
    "inputJson": "{\"\\u20ac\":5,\"\\r\":1,\"\\ufb33\":7,\"1\":2,\"\\ud83d\\ude00\":6,\"\\u0080\":3,\"\\u00f6\":4}",
    "canonicalUtf8": "{\"\\r\":1,\"1\":2,\"\":3,\"ö\":4,\"€\":5,\"😀\":6,\"דּ\":7}",
    "sha256": "4bd52d82f332c2e5c7206abd57c74b45dd4f0fef63ab7af87b8bde4481e450e7",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2.3",
    "accept": true
  },
  {
    "id": "rfc8785-primitive-serialization-adapted",
    "kind": "json",
    "inputJson": "{\"numbers\":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],\"literal\":[null,true,false],\"text\":\"\\u20ac\\u000F\\u000a\\u0022\\u005c/\"}",
    "canonicalUtf8": "{\"literal\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"text\":\"€\\u000f\\n\\\"\\\\/\"}",
    "sha256": "c44e73582a51d5936b74c943b9c11b08af5b6f276728c21e57828449b3192e00",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2.2",
    "accept": true
  },
  {
    "id": "rfc8785-recursive-object-order-array-stability",
    "kind": "json",
    "inputJson": "{\"z\":[{\"z\":0,\"a\":1},2,1],\"a\":{\"2\":2,\"10\":10}}",
    "canonicalUtf8": "{\"a\":{\"10\":10,\"2\":2},\"z\":[{\"a\":1,\"z\":0},2,1]}",
    "sha256": "ad9e856132cf86f7bd2e6c3b32d860a70476b8ee1fc5ac8e055e8cb8aa5c35b4",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2.3",
    "accept": true
  },
  {
    "id": "rfc8785-no-unicode-normalization",
    "kind": "json",
    "inputJson": "{\"é\":1,\"e\\u0301\":2}",
    "canonicalUtf8": "{\"é\":2,\"é\":1}",
    "sha256": "a7962fb10dc1255be368ece9c22b2256605921dc6d0a8c9409d3ee406bcb86e5",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1",
    "accept": true
  },
  {
    "id": "rfc8785-number-0000000000000000",
    "kind": "ieee754",
    "ieee754Hex": "0000000000000000",
    "canonicalUtf8": "0",
    "sha256": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-8000000000000000",
    "kind": "ieee754",
    "ieee754Hex": "8000000000000000",
    "canonicalUtf8": "0",
    "sha256": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-0000000000000001",
    "kind": "ieee754",
    "ieee754Hex": "0000000000000001",
    "canonicalUtf8": "5e-324",
    "sha256": "c46e7ca1be4c8734f373a56530787288fa2058d73d07855e9247e949f811a42a",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-8000000000000001",
    "kind": "ieee754",
    "ieee754Hex": "8000000000000001",
    "canonicalUtf8": "-5e-324",
    "sha256": "046f4049d09944fcb2efbf2ddb0ea8f05e0204591d6d02c9106efc88190fa7f9",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-7fefffffffffffff",
    "kind": "ieee754",
    "ieee754Hex": "7fefffffffffffff",
    "canonicalUtf8": "1.7976931348623157e+308",
    "sha256": "c2784e1abd6317452708f3fbf9641c16b959561bc621a1d408c23a20aa2cb585",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-ffefffffffffffff",
    "kind": "ieee754",
    "ieee754Hex": "ffefffffffffffff",
    "canonicalUtf8": "-1.7976931348623157e+308",
    "sha256": "f0347276b171ff0c36491c912285a2833de7313d1a103a4b1be0274bfe7c021f",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-4340000000000000",
    "kind": "ieee754",
    "ieee754Hex": "4340000000000000",
    "canonicalUtf8": "9007199254740992",
    "sha256": "c681da39d7273a6a24c15c9cac3a75526ff2ecf8ba4ee60346a0c70c8163bdb2",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-c340000000000000",
    "kind": "ieee754",
    "ieee754Hex": "c340000000000000",
    "canonicalUtf8": "-9007199254740992",
    "sha256": "83e109bfd7fb4984b47a46f363627c18dbbd7e57e36b05a04cd162d304df72e9",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-4430000000000000",
    "kind": "ieee754",
    "ieee754Hex": "4430000000000000",
    "canonicalUtf8": "295147905179352830000",
    "sha256": "7933ef1b34c194c7a327ef424e54282dd2872bc7bda27812f9edf7882ca340c0",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-44b52d02c7e14af5",
    "kind": "ieee754",
    "ieee754Hex": "44b52d02c7e14af5",
    "canonicalUtf8": "9.999999999999997e+22",
    "sha256": "143eadc1fc2fe10a563df313c717399d1835652d710fa189119ff2e1d5cde33d",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-44b52d02c7e14af6",
    "kind": "ieee754",
    "ieee754Hex": "44b52d02c7e14af6",
    "canonicalUtf8": "1e+23",
    "sha256": "0b1af6b73e932475817f8eb620deecf21ad7570df3400a23db5c79a9001597f7",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-44b52d02c7e14af7",
    "kind": "ieee754",
    "ieee754Hex": "44b52d02c7e14af7",
    "canonicalUtf8": "1.0000000000000001e+23",
    "sha256": "de7cb5db5ee06bf7ef5b74ebcf94cd9d7efda28125905f7ff590724953173c7b",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-444b1ae4d6e2ef4e",
    "kind": "ieee754",
    "ieee754Hex": "444b1ae4d6e2ef4e",
    "canonicalUtf8": "999999999999999700000",
    "sha256": "dcabf7269f6bb6ec5ba8b9530825cd7ffe215d4dd26e0a237f9d753513792c07",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-444b1ae4d6e2ef4f",
    "kind": "ieee754",
    "ieee754Hex": "444b1ae4d6e2ef4f",
    "canonicalUtf8": "999999999999999900000",
    "sha256": "914b4f8b4bbe2f6e7c36ad7791fc842a7516d149e694b3a71b78cee465ff6d7a",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-444b1ae4d6e2ef50",
    "kind": "ieee754",
    "ieee754Hex": "444b1ae4d6e2ef50",
    "canonicalUtf8": "1e+21",
    "sha256": "241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-3eb0c6f7a0b5ed8c",
    "kind": "ieee754",
    "ieee754Hex": "3eb0c6f7a0b5ed8c",
    "canonicalUtf8": "9.999999999999997e-7",
    "sha256": "2ace34b29d30d300aeacd4f2bb83367fa186f11a3f02ed461f35f00fd741a242",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-3eb0c6f7a0b5ed8d",
    "kind": "ieee754",
    "ieee754Hex": "3eb0c6f7a0b5ed8d",
    "canonicalUtf8": "0.000001",
    "sha256": "159fb29a827ad04b260aa6c8ab6d8637f8f2b38af5c4f3cb49d6a21205e040f8",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-41b3de4355555553",
    "kind": "ieee754",
    "ieee754Hex": "41b3de4355555553",
    "canonicalUtf8": "333333333.3333332",
    "sha256": "0fdb7bafaf219ccaf278cd0c0a580473db01c774a0baafe72a07d01230ac5c6d",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-41b3de4355555554",
    "kind": "ieee754",
    "ieee754Hex": "41b3de4355555554",
    "canonicalUtf8": "333333333.33333325",
    "sha256": "bcbe1777b7d3c91c19c7f90100c595a9b3f1d9b395567da4258baf7ac655d403",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-41b3de4355555555",
    "kind": "ieee754",
    "ieee754Hex": "41b3de4355555555",
    "canonicalUtf8": "333333333.3333333",
    "sha256": "6bd9be1c141028789cc35db62f1b43e80d5d4ee24d6d542e775deb16799ff4c7",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-41b3de4355555556",
    "kind": "ieee754",
    "ieee754Hex": "41b3de4355555556",
    "canonicalUtf8": "333333333.3333334",
    "sha256": "1e099031ca0cb3cf4054688f7e2e8c95fc72828de5fa7605ce3f729e6cf79d43",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-41b3de4355555557",
    "kind": "ieee754",
    "ieee754Hex": "41b3de4355555557",
    "canonicalUtf8": "333333333.33333343",
    "sha256": "cf68ab5e198a77538aafd967fb122a305ba1df95c9348b1fe3dff453c7f7215f",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-becbf647612f3696",
    "kind": "ieee754",
    "ieee754Hex": "becbf647612f3696",
    "canonicalUtf8": "-0.0000033333333333333333",
    "sha256": "4e703d4e0928e4f339d03e1fb5454ddc33db657ad735b02530d98123b4fd4b61",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-number-43143ff3c1cb0959",
    "kind": "ieee754",
    "ieee754Hex": "43143ff3c1cb0959",
    "canonicalUtf8": "1424953923781206.2",
    "sha256": "e1547479d27f057e3197d49417a1dcbe19dd8781b34fa9f83b789925943d00cb",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": true
  },
  {
    "id": "rfc8785-reject-lone-surrogate-value",
    "kind": "json",
    "inputJson": "{\"a\":\"\\udead\"}",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1",
    "accept": false,
    "rule": "UNICODE_SCALAR"
  },
  {
    "id": "rfc8785-reject-lone-surrogate-key",
    "kind": "json",
    "inputJson": "{\"\\ud800\":1}",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1",
    "accept": false,
    "rule": "UNICODE_SCALAR"
  },
  {
    "id": "rfc8785-reject-duplicate-keys",
    "kind": "json",
    "inputJson": "{\"a\":1,\"a\":2}",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1",
    "accept": false,
    "rule": "DUPLICATE_KEYS"
  },
  {
    "id": "rfc8785-reject-overflow-number",
    "kind": "json",
    "inputJson": "{\"a\":1e9999}",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1",
    "accept": false,
    "rule": "FINITE_IEEE754"
  },
  {
    "id": "rfc8785-reject-number-7fffffffffffffff",
    "kind": "ieee754",
    "ieee754Hex": "7fffffffffffffff",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": false,
    "rule": "FINITE_IEEE754"
  },
  {
    "id": "rfc8785-reject-number-7ff0000000000000",
    "kind": "ieee754",
    "ieee754Hex": "7ff0000000000000",
    "source": "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B",
    "accept": false,
    "rule": "FINITE_IEEE754"
  }
];
