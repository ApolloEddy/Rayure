import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const objPath = 'D:/CodingProjects/Mixed_Language/Rayure/apps/wallpaper/public/assets/scenes/cozy_bedroom.obj';
const glbPath = 'D:/CodingProjects/Mixed_Language/Rayure/apps/wallpaper/public/assets/scenes/cozy_bedroom.glb';

console.log('Loading OBJ into Three.js...');
const objText = fs.readFileSync(objPath, 'utf-8');
const loader = new OBJLoader();
const root = loader.parse(objText);

// 隐藏封闭外墙（Cube.002, Cube.018）
root.traverse((c) => {
  if ((c as THREE.Mesh).isMesh) {
    if (c.name === 'Cube.002' || c.name === 'Cube.018') {
      c.visible = false;
    }
  }
});

console.log('Exporting pure binary GLB (fast load)...');
const exporter = new GLTFExporter();
exporter.parse(
  root,
  (glbBuffer) => {
    fs.writeFileSync(glbPath, Buffer.from(glbBuffer as ArrayBuffer));
    console.log(`SUCCESS: Exported cozy_bedroom.glb -> ${glbPath} (${fs.statSync(glbPath).size} bytes)`);
  },
  (err) => console.error('Export GLB error:', err),
  { binary: true }
);
