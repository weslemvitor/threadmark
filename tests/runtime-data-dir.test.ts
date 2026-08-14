import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { defaultSupportDataDirectory } from "../server/runtime/config.js";

test("diretório padrão de dados permanece fora do pacote em cada sistema", () => {
  assert.equal(
    defaultSupportDataDirectory({
      platform: "darwin",
      homeDirectory: "/Users/threadmark",
      environment: {},
    }),
    "/Users/threadmark/Library/Application Support/Threadmark",
  );
  assert.equal(
    defaultSupportDataDirectory({
      platform: "linux",
      homeDirectory: "/home/threadmark",
      environment: { XDG_DATA_HOME: "/var/lib/threadmark-user" },
    }),
    "/var/lib/threadmark-user/threadmark",
  );
  assert.equal(
    defaultSupportDataDirectory({
      platform: "linux",
      homeDirectory: "/home/threadmark",
      environment: {},
    }),
    "/home/threadmark/.local/share/threadmark",
  );
  assert.equal(
    defaultSupportDataDirectory({
      platform: "win32",
      homeDirectory: String.raw`C:\Users\threadmark`,
      environment: { LOCALAPPDATA: String.raw`C:\Users\threadmark\AppData\Local` },
    }),
    path.win32.join(
      String.raw`C:\Users\threadmark\AppData\Local`,
      "Threadmark",
    ),
  );
});
