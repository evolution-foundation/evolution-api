#! /bin/bash

cd evolution-manager-v2
npm install
npm run build
cd ..
rm -rf manager/dist
cp -r evolution-manager-v2/dist manager/dist