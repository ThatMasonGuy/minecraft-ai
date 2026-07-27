const THREE = require("three");
const TWEEN = require("@tweenjs/tween.js");
const entityModels = require("prismarine-viewer/viewer/lib/entity/entities.json");
const { dispose3 } = require("prismarine-viewer/viewer/lib/dispose");

const faces = {
  up: {
    dir: [0, 1, 0],
    u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 0, 1],
    corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 1, 0, 0, 1], [1, 1, 0, 1, 1]]
  },
  down: {
    dir: [0, -1, 0],
    u0: [1, 0, 1], v0: [0, 0, 0], u1: [2, 0, 1], v1: [0, 0, 1],
    corners: [[1, 0, 1, 0, 0], [0, 0, 1, 1, 0], [1, 0, 0, 0, 1], [0, 0, 0, 1, 1]]
  },
  east: {
    dir: [1, 0, 0],
    u0: [0, 0, 0], v0: [0, 0, 1], u1: [0, 0, 1], v1: [0, 1, 1],
    corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]]
  },
  west: {
    dir: [-1, 0, 0],
    u0: [1, 0, 1], v0: [0, 0, 1], u1: [1, 0, 2], v1: [0, 1, 1],
    corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]]
  },
  north: {
    dir: [0, 0, -1],
    u0: [0, 0, 1], v0: [0, 0, 1], u1: [1, 0, 1], v1: [0, 1, 0],
    corners: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]]
  },
  south: {
    dir: [0, 0, 1],
    u0: [1, 0, 2], v0: [0, 0, 1], u1: [2, 0, 2], v1: [0, 1, 1],
    corners: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]]
  }
};

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function addCube(attributes, bone, cube, textureWidth = 64, textureHeight = 64) {
  const rotation = new THREE.Euler(
    -(cube.rotation?.[0] || 0) * Math.PI / 180,
    -(cube.rotation?.[1] || 0) * Math.PI / 180,
    -(cube.rotation?.[2] || 0) * Math.PI / 180
  );
  for (const { dir, corners, u0, v0, u1, v1 } of Object.values(faces)) {
    const first = Math.floor(attributes.positions.length / 3);
    for (const position of corners) {
      const u = (cube.uv[0] + dot(position[3] ? u1 : u0, cube.size)) / textureWidth;
      const v = (cube.uv[1] + dot(position[4] ? v1 : v0, cube.size)) / textureHeight;
      const inflate = cube.inflate || 0;
      let point = new THREE.Vector3(
        cube.origin[0] + position[0] * cube.size[0] + (position[0] ? inflate : -inflate),
        cube.origin[1] + position[1] * cube.size[1] + (position[1] ? inflate : -inflate),
        cube.origin[2] + position[2] * cube.size[2] + (position[2] ? inflate : -inflate)
      );
      point = point.applyEuler(rotation).sub(bone.position).applyEuler(bone.rotation).add(bone.position);
      attributes.positions.push(point.x, point.y, point.z);
      attributes.normals.push(...dir);
      attributes.uvs.push(u, v);
    }
    attributes.indices.push(first, first + 1, first + 2, first + 2, first + 1, first + 3);
  }
}

function createModelMesh(texturePath, model) {
  const bones = {};
  const attributes = {
    positions: [], normals: [], uvs: [], indices: []
  };

  model.bones.forEach((jsonBone) => {
    const bone = new THREE.Bone();
    if (jsonBone.pivot) bone.position.set(...jsonBone.pivot);
    const rotation = jsonBone.bind_pose_rotation || jsonBone.rotation;
    if (rotation) {
      bone.rotation.set(
        -rotation[0] * Math.PI / 180,
        -rotation[1] * Math.PI / 180,
        -rotation[2] * Math.PI / 180
      );
    }
    bones[jsonBone.name] = bone;
    for (const cube of jsonBone.cubes || []) {
      addCube(attributes, bone, cube, model.texturewidth, model.textureheight);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(attributes.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(attributes.normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(attributes.uvs, 2));
  geometry.setIndex(attributes.indices);

  const material = new THREE.MeshLambertMaterial({
    transparent: true,
    alphaTest: 0.1
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(1 / 16);

  new THREE.TextureLoader().load(texturePath, (texture) => {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.flipY = false;
    material.map = texture;
    material.needsUpdate = true;
  });
  return mesh;
}

function createEntityMesh(entity, version) {
  const definition = entityModels[entity.name];
  if (definition) {
    const variant = definition.geometry.default
      ? "default"
      : Object.keys(definition.geometry)[0];
    const model = definition.geometry[variant];
    const texture = definition.textures[variant] || definition.textures.default;
    if (model && texture) {
      const root = new THREE.Object3D();
      root.add(
        createModelMesh(
          `/${texture.replace("textures", `textures/${version}`)}.png`,
          model
        )
      );
      return root;
    }
  }

  const geometry = new THREE.BoxGeometry(entity.width || 0.6, entity.height || 1, entity.width || 0.6);
  geometry.translate(0, (entity.height || 1) / 2, 0);
  return new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: 0x778899, transparent: true, opacity: 0.8 })
  );
}

class ViewerEntities {
  constructor(scene, version) {
    this.scene = scene;
    this.version = version;
    this.entities = {};
  }

  clear() {
    for (const mesh of Object.values(this.entities)) {
      this.scene.remove(mesh);
      dispose3(mesh);
    }
    this.entities = {};
  }

  update(entity) {
    if (entity.delete) {
      const existing = this.entities[entity.id];
      if (existing) {
        this.scene.remove(existing);
        dispose3(existing);
        delete this.entities[entity.id];
      }
      return;
    }
    if (!this.entities[entity.id]) {
      const mesh = createEntityMesh(entity, this.version);
      this.entities[entity.id] = mesh;
      this.scene.add(mesh);
    }
    const mesh = this.entities[entity.id];
    if (entity.pos) {
      new TWEEN.Tween(mesh.position)
        .to({ x: entity.pos.x, y: entity.pos.y, z: entity.pos.z }, 50)
        .start();
    }
    if (entity.yaw !== undefined) {
      const delta = (entity.yaw - mesh.rotation.y) % (Math.PI * 2);
      const shortest = (2 * delta) % (Math.PI * 2) - delta;
      new TWEEN.Tween(mesh.rotation)
        .to({ y: mesh.rotation.y + shortest }, 50)
        .start();
    }
  }
}

module.exports = { ViewerEntities };
