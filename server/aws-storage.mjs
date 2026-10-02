import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';

const clients = new Map();

export const awsCredentials = () => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
};

export const getS3Client = (region) => {
  if (!clients.has(region)) {
    clients.set(region, new S3Client({region, credentials: awsCredentials()}));
  }
  return clients.get(region);
};

const contentTypeFor = (filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }[extension] || 'application/octet-stream';
};

const safeName = (filePath) =>
  path.basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '-');

export const uploadFileCached = async ({filePath, bucketName, region}) => {
  const stat = await fs.stat(filePath);
  const objectKey = `prayer-media/${stat.size}-${Math.round(stat.mtimeMs)}/${safeName(filePath)}`;
  const client = getS3Client(region);
  let exists = true;
  try {
    await client.send(new HeadObjectCommand({Bucket: bucketName, Key: objectKey}));
  } catch (error) {
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      exists = false;
    } else {
      throw error;
    }
  }
  if (!exists) {
    await new Upload({
      client,
      params: {
        Bucket: bucketName,
        Key: objectKey,
        Body: createReadStream(filePath),
        ContentType: contentTypeFor(filePath),
      },
      queueSize: 3,
      leavePartsOnError: false,
    }).done();
  }
  return objectKey;
};

export const putJson = async ({bucketName, objectKey, region, value}) => {
  await getS3Client(region).send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    }),
  );
};

export const getJson = async ({bucketName, objectKey, region}) => {
  const result = await getS3Client(region).send(
    new GetObjectCommand({Bucket: bucketName, Key: objectKey}),
  );
  return JSON.parse(await result.Body.transformToString('utf8'));
};

export const headObject = async ({bucketName, objectKey, region}) =>
  getS3Client(region).send(
    new HeadObjectCommand({Bucket: bucketName, Key: objectKey}),
  );

export const getObject = async ({bucketName, objectKey, region}) =>
  getS3Client(region).send(
    new GetObjectCommand({Bucket: bucketName, Key: objectKey}),
  );

export const downloadObject = async ({bucketName, objectKey, region, destination}) => {
  await fs.mkdir(path.dirname(destination), {recursive: true});
  const temporary = `${destination}.part`;
  const object = await getObject({bucketName, objectKey, region});
  try {
    const {createWriteStream} = await import('node:fs');
    await pipeline(object.Body, createWriteStream(temporary));
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, {force: true}).catch(() => undefined);
    throw error;
  }
  return destination;
};
