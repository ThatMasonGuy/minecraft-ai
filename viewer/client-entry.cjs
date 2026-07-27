globalThis.THREE = require("three");
const THREE = globalThis.THREE;
const TWEEN = require("@tweenjs/tween.js");
require("three/examples/js/controls/OrbitControls");

const { Viewer } = require("prismarine-viewer/viewer");
const io = require("socket.io-client");
const { ViewerEntities } = require("./client-entities.cjs");

const socket = io({ path: `${window.location.pathname}socket.io` });
const renderer = new THREE.WebGLRenderer();
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const viewer = new Viewer(renderer);
let controls = new THREE.OrbitControls(viewer.camera, renderer.domElement);

function animate() {
  window.requestAnimationFrame(animate);
  if (controls) controls.update();
  viewer.update();
  renderer.render(viewer.scene, viewer.camera);
}
animate();

window.addEventListener("resize", () => {
  viewer.camera.aspect = window.innerWidth / window.innerHeight;
  viewer.camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

socket.on("version", (version) => {
  if (!viewer.setVersion(version)) return;
  viewer.entities.clear();
  viewer.entities = new ViewerEntities(viewer.scene, version);
  viewer.listen(socket);

  socket.on("position", ({ pos, yaw, pitch }) => {
    if (yaw === undefined || pitch === undefined) return;
    if (controls) {
      controls.dispose();
      controls = null;
    }
    viewer.setFirstPersonCamera(pos, yaw, pitch);
  });
});
