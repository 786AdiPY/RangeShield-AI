"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './Navbar.module.css';

const Navbar = () => {
    return (
        <nav className={styles.nav}>
            <div className={styles.logo}>
                <Link href="/">Home</Link>
            </div>
            <div className={styles.links}>
                <Link href="/plan">Plan</Link>
                <Link href="/trip">Trip</Link>
            </div>
        </nav>
    );
};

export default Navbar;
