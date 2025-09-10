// Impor statis yang masih dibutuhkan
import settings from '../data/settings.json';
import layout from '../templates/layout.html';
import postsTemplate from '../templates/posts.html';
import singleTemplate from '../templates/single.html';
import { renderTemplate } from '../utils/renderer.js';
import { generateMeta } from '../utils/seo.js';
import { generateMobileMenu, generateFooterMenu } from '../utils/menu.js';

/**
 * Variabel cache global untuk menyimpan data posts.
 * Ini mencegah Worker mengambil data dari GitHub berulang-ulang,
 * sehingga meningkatkan kecepatan dan efisiensi.
 */
let postsCache = null;

/**
 * Mengambil data posts dari URL GitHub Raw dan menyimpannya di cache.
 * @param {object} env - Variabel lingkungan dari Cloudflare (diisi oleh secrets).
 * @returns {Promise<Array>} - Promise yang akan resolve dengan array data posts.
 */
async function getPosts(env) {
	// 1. Jika data sudah ada di cache, langsung kembalikan untuk performa maksimal.
	if (postsCache) {
		return postsCache;
	}

	// 2. Ambil username dan nama repo dari secrets yang sudah diatur oleh skrip PHP.
	const githubUser = env.GITHUB_USERNAME;
	const repoName = env.REPO_NAME;

	if (!githubUser || !repoName) {
		throw new Error('Secrets GITHUB_USERNAME dan REPO_NAME belum diatur di Cloudflare.');
	}

	// 3. Bentuk URL lengkap ke file posts.json di repositori GitHub publik Anda.
	const POSTS_URL = `https://raw.githubusercontent.com/${githubUser}/${repoName}/main/public/data/posts.json`;

	console.log(`Mengambil data dari: ${POSTS_URL}`);
	const response = await fetch(POSTS_URL, {
        // Menambahkan header User-Agent adalah praktik yang baik
        headers: {
            'User-Agent': 'Cloudflare-Worker-Blog-Fetcher'
        }
    });

	if (!response.ok) {
		throw new Error(`Gagal mengambil data posts dari GitHub. Status: ${response.status}`);
	}

	const data = await response.json();

	// 4. Simpan data yang berhasil diambil ke dalam cache untuk request berikutnya.
	postsCache = data;

	return data;
}

/**
 * Menampilkan halaman daftar semua post.
 * @param {object} env - Variabel lingkungan Cloudflare.
 */
async function showPostList(env) {
	// Ambil data posts terlebih dahulu
	const postsData = await getPosts(env);

	const postsHtml = postsData
		.map((post) => {
			const cleanedTitle = cleanTitle(post.title);
			const firstImage = getFirstImage(post.content);
			return `<div class="post-item"><a href="/${post.slug}"><img src="${firstImage}" alt="${cleanedTitle}" loading="lazy"><h3>${cleanedTitle}</h3></a></div>`;
		})
		.join('');

	const pageContent = await renderTemplate(postsTemplate, { POST_LIST: postsHtml });
	const meta = generateMeta({ title: settings.siteTitle, description: settings.siteDescription });

	const finalHtml = await renderTemplate(layout, {
		SEO_TITLE: meta.title,
		PAGE_CONTENT: pageContent,
		SITE_TITLE: settings.siteTitle,
		MOBILE_MENU_LINKS: generateMobileMenu(),
		FOOTER_MENU_LINKS: generateFooterMenu(),
		JSON_LD_SCRIPT: '',
	});

	return new Response(finalHtml, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/**
 * Menampilkan halaman untuk satu post tunggal berdasarkan slug.
 * @param {string} slug - Slug dari post yang akan ditampilkan.
 * @param {object} env - Variabel lingkungan Cloudflare.
 */
async function showSinglePost(slug, env) {
	// Ambil data posts terlebih dahulu
	const postsData = await getPosts(env);
	const post = postsData.find((p) => p.slug === slug);

	if (!post) return new Response('Postingan tidak ditemukan', { status: 404 });

	const cleanedTitle = cleanTitle(post.title);
	const mainContent = getMainContent(post.content);

	const pageContent = await renderTemplate(singleTemplate, {
		POST_TITLE: cleanedTitle,
		POST_CONTENT: mainContent,
		RELATED_POSTS: getRelatedPosts(slug, postsData), // Kirim postsData sebagai argumen
	});

	const metaPost = { ...post, title: cleanedTitle };
	const meta = generateMeta(metaPost);

	const finalHtml = await renderTemplate(layout, {
		SEO_TITLE: meta.title,
		PAGE_CONTENT: pageContent,
		SITE_TITLE: settings.siteTitle,
		MOBILE_MENU_LINKS: generateMobileMenu(),
		FOOTER_MENU_LINKS: generateFooterMenu(),
		JSON_LD_SCRIPT: post.json_ld || '',
	});

	return new Response(finalHtml, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/**
 * Handler utama yang akan diekspor.
 * Mengarahkan request ke fungsi yang tepat berdasarkan URL.
 * @param {Request} request - Objek request yang masuk.
 * @param {object} env - Variabel lingkungan Cloudflare.
 */
export async function handlePostsRequest(request, env) {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === '/' || path === '') {
		return await showPostList(env);
	}

	// Ambil slug dari path, misalnya "/nama-post-saya" -> "nama-post-saya"
	const pathParts = path.split('/').filter((part) => part.length > 0);
	if (pathParts.length === 1) {
		return await showSinglePost(pathParts[0], env);
	}

	return new Response('Halaman tidak ditemukan', { status: 404 });
}

// --- FUNGSI-FUNGSI HELPER (PEMBANTU) ---

function cleanTitle(title) {
	const cutoffIndex = title.indexOf('');
	if (cutoffIndex !== -1) {
		return title.substring(0, cutoffIndex).trim();
	}
	const separators = [' | ', ' – '];
	for (const sep of separators) {
		if (title.includes(sep)) {
			return title.split(sep)[0].trim();
		}
	}
	return title;
}

function getMainContent(htmlContent) {
	const searchTag = 'If you are searching about';
	const searchIndex = htmlContent.indexOf(searchTag);
	if (searchIndex !== -1) {
		return htmlContent.substring(0, searchIndex);
	}
	return htmlContent;
}

function getFirstImage(htmlContent) {
	const match = htmlContent.match(/<img src=(?:\"|')([^\"']+)(\"|')/);
	return match ? match[1] : 'https://placehold.co/300x200/png'; // Gambar placeholder jika tidak ada
}

function getRelatedPosts(currentSlug, allPosts) {
	// Ambil 5 post acak yang tidak sama dengan post saat ini
	const related = allPosts.filter(p => p.slug !== currentSlug);
	const shuffled = related.sort(() => 0.5 - Math.random());
	return shuffled.slice(0, 5).map(post => {
        return `<li><a href="/${post.slug}">${cleanTitle(post.title)}</a></li>`;
    }).join('');
}