const express = require('express');
const app = express();

const fs = require('fs');
const mysql = require('mysql2');

app.use(express.json());

