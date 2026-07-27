const path = require("node:path");
const webpack = require("webpack");

module.exports = {
  entry: "./viewer/client-entry.cjs",
  mode: "production",
  output: {
    path: path.resolve(__dirname, "viewer/generated"),
    filename: "index.js"
  },
  resolve: {
    fallback: {
      zlib: false
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: "process/browser"
    }),
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"]
    }),
    new webpack.NormalModuleReplacementPlugin(
      /viewer[\/\\]lib[\/\\]utils/,
      "./utils.web.js"
    )
  ],
  externals: [
    function ({ context, request }, callback) {
      const blocked = ["blocksB2J", "blocksJ2B", "blockMappings", "steve", "recipes"];
      if (
        context?.includes("minecraft-data") &&
        request?.endsWith(".json") &&
        blocked.includes(request.split("/").pop().replace(".json", ""))
      ) {
        callback(null, "[]");
        return;
      }
      callback();
    }
  ]
};
